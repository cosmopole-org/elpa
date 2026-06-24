//! The host-call envelope emitted by the VM when it pauses on `askHost`.

use serde::{Deserialize, Serialize};

/// Mirror of the JSON the VM produces in `VmExecResult::host_call_data`:
/// `{"machineId", "apiName", "payload"}`.
///
/// `payload` is the **raw JSON text** of the call arguments — *not* an escaped
/// JSON string. The VM splices the payload object straight into the envelope
/// so the runtime can JSON-parse the payload once, instead of un-escaping and
/// then re-parsing it. The shape of that JSON depends entirely on `api_name`
/// (a [`crate::Frame`] array for `gpu.submit`, a buffer write for
/// `gpu.writeBuffer`, a line for `log`).
#[derive(Debug, Clone, Default)]
pub struct HostCall {
    pub machine_id: String,
    pub api_name: String,
    /// Raw JSON text of the call arguments; parse per `api_name`.
    pub payload: String,
}

impl HostCall {
    /// Parse the envelope JSON the VM hands back to the embedder.
    ///
    /// Accepts both wire shapes the codebase has used:
    /// * `payload` as raw JSON (new, no double escape) — the common path;
    /// * `payload` as an escaped JSON string (legacy / fixtures).
    pub fn parse(json: &str) -> Result<HostCall, serde_json::Error> {
        let mut v: serde_json::Value = serde_json::from_str(json)?;
        let machine_id = take_string(&mut v, "machineId");
        let api_name = take_string(&mut v, "apiName");
        let payload = match v.get_mut("payload").map(|p| p.take()) {
            Some(serde_json::Value::String(s)) => s, // legacy escaped form
            Some(other) => other.to_string(),         // raw JSON form
            None => String::new(),
        };
        Ok(HostCall { machine_id, api_name, payload })
    }

    /// Parse `payload` into a typed value once the caller knows what to expect.
    pub fn payload_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.payload)
    }
}

fn take_string(v: &mut serde_json::Value, key: &str) -> String {
    match v.get_mut(key).map(|p| p.take()) {
        Some(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

// `HostCall` was serialized in older code paths (tests round-tripping through
// JSON, the API server's request log). Keep that contract by emitting the
// historical escaped-string `payload` shape — new callers that care about
// size should construct the envelope directly.
impl Serialize for HostCall {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("HostCall", 3)?;
        st.serialize_field("machineId", &self.machine_id)?;
        st.serialize_field("apiName", &self.api_name)?;
        st.serialize_field("payload", &self.payload)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for HostCall {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let mut v: serde_json::Value = serde_json::Value::deserialize(d)?;
        let machine_id = take_string(&mut v, "machineId");
        let api_name = take_string(&mut v, "apiName");
        let payload = match v.get_mut("payload").map(|p| p.take()) {
            Some(serde_json::Value::String(s)) => s,
            Some(other) => other.to_string(),
            None => String::new(),
        };
        Ok(HostCall { machine_id, api_name, payload })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_submit_envelope_legacy_escaped() {
        let raw = r#"{"machineId":"m1","apiName":"gpu.submit","payload":"{\"commands\":[]}"}"#;
        let hc = HostCall::parse(raw).unwrap();
        assert_eq!(hc.api_name, "gpu.submit");
        assert_eq!(hc.machine_id, "m1");
        assert_eq!(hc.payload, "{\"commands\":[]}");
    }

    #[test]
    fn parses_submit_envelope_raw_inline() {
        let raw = r#"{"machineId":"m1","apiName":"gpu.submit","payload":{"commands":[]}}"#;
        let hc = HostCall::parse(raw).unwrap();
        assert_eq!(hc.api_name, "gpu.submit");
        assert_eq!(hc.payload, r#"{"commands":[]}"#);
    }
}
