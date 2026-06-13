//! The host-call envelope emitted by the VM when it pauses on `askHost`.

use serde::{Deserialize, Serialize};

/// Mirror of the JSON the VM produces in `VmExecResult::host_call_data`:
/// `{"machineId", "apiName", "payload"}`. `payload` is kept as a raw JSON
/// string because its shape depends entirely on `api_name` (a [`crate::Frame`]
/// for `gpu.submit`, a buffer write for `gpu.writeBuffer`, a line for `log`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCall {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(rename = "apiName")]
    pub api_name: String,
    /// Raw JSON string of the call arguments; parse per `api_name`.
    pub payload: String,
}

impl HostCall {
    /// Parse the envelope JSON the VM hands back to the embedder.
    pub fn parse(json: &str) -> Result<HostCall, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Parse `payload` into a typed value once the caller knows what to expect.
    pub fn payload_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_submit_envelope() {
        let raw = r#"{"machineId":"m1","apiName":"gpu.submit","payload":"{\"commands\":[]}"}"#;
        let hc = HostCall::parse(raw).unwrap();
        assert_eq!(hc.api_name, "gpu.submit");
        assert_eq!(hc.machine_id, "m1");
    }
}
