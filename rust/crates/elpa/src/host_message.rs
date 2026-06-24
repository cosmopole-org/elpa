//! The custom **messaging pipe** between the JavaScript running on the Elpian VM
//! and the embedding host (e.g. a Flutter application).
//!
//! Two directions, both application-defined:
//!
//! * **guest → host** — the app calls `host.send(channel, message)` for a
//!   fire-and-forget post, or `host.request(channel, message)` for a synchronous
//!   round-trip. The instance services these in its host-call dispatch:
//!   `host.send` enqueues a [`HostMessage`] the embedder drains with
//!   [`Elpa::take_outbound_messages`](crate::Elpa::take_outbound_messages);
//!   `host.request` is answered inline by the host's installed
//!   [`RequestHandler`], whose reply becomes the call's return value in the VM.
//! * **host → guest** — the embedder calls
//!   [`Elpa::post_message`](crate::Elpa::post_message), which invokes the guest's
//!   `onHostMessage(msg)` and pumps whatever it does in response (re-render, a
//!   reply via `host.send`, …) through the same loop events use.
//!
//! The wire payload is kept as **raw JSON text** end to end — never re-escaped —
//! so a message round-trips through the pipe with a single parse on each side.
//! This is what keeps the channel high-throughput: the VM splices the message
//! JSON straight into the host-call envelope, the instance moves it as a `String`
//! without touching its contents, and the embedder (Flutter) decodes it once.

use elpa_protocol::HostCall;

/// One message crossing the pipe: a `channel` selector plus its `payload`, the
/// **raw JSON text** of the message value. Keeping the payload as text (rather
/// than a parsed [`serde_json::Value`]) means the instance never pays to parse or
/// re-serialize a message it only forwards — the host/guest at the ends own the
/// single parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostMessage {
    /// Application-defined routing selector (e.g. `"nav"`, `"telemetry"`).
    pub channel: String,
    /// The message value as raw JSON text.
    pub payload: String,
}

impl HostMessage {
    pub fn new(channel: impl Into<String>, payload: impl Into<String>) -> Self {
        HostMessage { channel: channel.into(), payload: payload.into() }
    }
}

/// A host-installed responder for `host.request` round-trips. It receives the
/// `channel` and the raw-JSON `message`, and returns the **typed JSON** reply the
/// VM injects as the call's return value (e.g. `{"type":"string","data":{...}}`,
/// or a bare value the VM types itself). Return `"null"` to decline.
pub type RequestHandler = Box<dyn FnMut(&str, &str) -> String + 'static>;

/// Parse the `(channel, message)` pair out of a `host.send` / `host.request`
/// payload. The VM wraps `askHost` arguments in a JSON array, so the accepted
/// shapes are:
///
/// * `["channel", <message>]` — the idiomatic two-argument call;
/// * `[{"channel":"…","message":<message>}]` — a single object argument;
/// * `["channel"]` — a bare channel with an empty (`null`) message.
///
/// `message` may be any JSON value; it is returned as its raw text so it is
/// forwarded without a re-serialize. Returns `None` if no channel can be found.
pub fn parse_message(call: &HostCall) -> Option<HostMessage> {
    let v: serde_json::Value = serde_json::from_str(&call.payload).ok()?;
    let items = v.as_array()?;
    match items.first()? {
        // ["channel", <message>] — the common, two-positional-arg form.
        serde_json::Value::String(channel) => {
            let payload = items.get(1).map(|m| m.to_string()).unwrap_or_else(|| "null".to_string());
            Some(HostMessage::new(channel.clone(), payload))
        }
        // [{ channel, message }] — a single structured argument.
        serde_json::Value::Object(map) => {
            let channel = map.get("channel").and_then(|c| c.as_str())?.to_string();
            let payload = map.get("message").map(|m| m.to_string()).unwrap_or_else(|| "null".to_string());
            Some(HostMessage::new(channel, payload))
        }
        _ => None,
    }
}

/// Build the JSON the host hands to `onHostMessage` for an inbound (host → guest)
/// message: `{"channel": "<channel>", "message": <payload>}`. `payload` is raw
/// JSON text and is spliced in unescaped, so the guest receives a structured
/// object, not a string it must re-parse.
pub fn inbound_input(channel: &str, payload_json: &str) -> String {
    let payload = if payload_json.trim().is_empty() { "null" } else { payload_json };
    format!("{{\"channel\":{},\"message\":{}}}", serde_json::Value::String(channel.to_string()), payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(api: &str, payload: &str) -> HostCall {
        HostCall { machine_id: "m".into(), api_name: api.into(), payload: payload.into() }
    }

    #[test]
    fn parses_two_arg_string_form() {
        let m = parse_message(&call("host.send", r#"["nav",{"to":"home"}]"#)).unwrap();
        assert_eq!(m.channel, "nav");
        assert_eq!(m.payload, r#"{"to":"home"}"#);
    }

    #[test]
    fn parses_object_form() {
        let m = parse_message(&call("host.request", r#"[{"channel":"db","message":[1,2,3]}]"#)).unwrap();
        assert_eq!(m.channel, "db");
        assert_eq!(m.payload, "[1,2,3]");
    }

    #[test]
    fn channel_only_defaults_to_null_message() {
        let m = parse_message(&call("host.send", r#"["ping"]"#)).unwrap();
        assert_eq!(m.channel, "ping");
        assert_eq!(m.payload, "null");
    }

    #[test]
    fn rejects_malformed_payload() {
        assert!(parse_message(&call("host.send", r#"[42]"#)).is_none());
        assert!(parse_message(&call("host.send", r#"[]"#)).is_none());
    }

    #[test]
    fn inbound_input_splices_payload_unescaped() {
        assert_eq!(inbound_input("nav", r#"{"to":"home"}"#), r#"{"channel":"nav","message":{"to":"home"}}"#);
        assert_eq!(inbound_input("ping", ""), r#"{"channel":"ping","message":null}"#);
    }
}
