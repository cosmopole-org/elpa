//! # elpa-runtime
//!
//! Drives the VM's pause/resume host-call loop. It is intentionally mechanical:
//! [`Runtime::pump`] steps the VM and hands every `askHost` request to a
//! caller-supplied `dispatch` closure, which returns the reply value. The
//! unified [`elpa`](../elpa/index.html) instance supplies that closure so it can
//! route `gpu.submit` to the renderer and `gpu.surfaceInfo` to live surface
//! state.
//!
//! ```text
//!   pump(start) ─▶ VM pauses on askHost ─▶ dispatch(&HostCall) -> reply
//!      ▲                                          │
//!      └──────────────── continue_execution ◀─────┘   (until done)
//! ```

use elpa_protocol::{Frame, HostCall};
use elpian_vm::api;

/// How to (re)enter the VM for one pump.
pub enum Start<'a> {
    /// Run the top-level program (app init).
    Main,
    /// Invoke a named function with a JSON input payload (e.g. an event).
    Func { name: &'a str, input: &'a str },
}

/// A handle to one running application VM. Each instance owns a unique
/// `machine_id` in the VM registry, so many `Runtime`s (apps) can coexist.
pub struct Runtime {
    machine_id: String,
    cb_counter: i64,
}

impl Runtime {
    /// Register a VM from an Elpian AST JSON program.
    pub fn from_ast(machine_id: impl Into<String>, ast_json: &str) -> Option<Runtime> {
        let machine_id = machine_id.into();
        if api::create_vm_from_ast(machine_id.clone(), ast_json.to_string()) {
            Some(Runtime { machine_id, cb_counter: 0 })
        } else {
            None
        }
    }

    pub fn machine_id(&self) -> &str {
        &self.machine_id
    }

    /// Step the VM from `start`, servicing each host call via `dispatch` until
    /// the VM finishes this turn. Returns the VM's final result value.
    pub fn pump(&mut self, start: Start, mut dispatch: impl FnMut(&HostCall) -> String) -> String {
        let mid = self.machine_id.clone();
        let mut result = match start {
            Start::Main => api::execute_vm(mid.clone()),
            Start::Func { name, input } => {
                self.cb_counter += 1;
                api::execute_vm_func_with_input(
                    mid.clone(),
                    name.to_string(),
                    input.to_string(),
                    self.cb_counter,
                )
            }
        };
        loop {
            if !result.has_host_call {
                return result.result_value;
            }
            let reply = match HostCall::parse(&result.host_call_data) {
                Ok(hc) => dispatch(&hc),
                Err(_) => reply_null(),
            };
            result = api::continue_execution(mid.clone(), reply);
        }
    }
}

/// Parse a `gpu.submit` host call's payload into a [`Frame`]. The VM wraps
/// `askHost` arguments in a JSON array, so the payload is `[<frame>]`; this
/// unwraps it.
pub fn frame_from_submit(call: &HostCall) -> Option<Frame> {
    if call.api_name != "gpu.submit" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&call.payload).ok()?;
    let frame_value = match v {
        serde_json::Value::Array(mut items) if !items.is_empty() => items.remove(0),
        other => other,
    };
    serde_json::from_value(frame_value).ok()
}

/// A typed-null reply (the VM accepts bare JSON and types it itself).
pub fn reply_null() -> String {
    "null".to_string()
}

/// Reply to a host call with a JSON value (becomes a VM object/array/scalar).
pub fn reply_json(value: &serde_json::Value) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_from_submit_unwraps_array() {
        let call = HostCall {
            machine_id: "m".into(),
            api_name: "gpu.submit".into(),
            payload: r#"[{"commands":[]}]"#.into(),
        };
        let f = frame_from_submit(&call).unwrap();
        assert!(f.commands.is_empty());
    }

    #[test]
    fn frame_from_submit_ignores_other_apis() {
        let call = HostCall { machine_id: "m".into(), api_name: "log".into(), payload: "[]".into() };
        assert!(frame_from_submit(&call).is_none());
    }
}
