//! # elpa-runtime
//!
//! Drives the VM's pause/resume host-call loop and routes calls to the renderer.
//! Elpa has no widget layer: the app's JS builds a [`Frame`] (a wgpu command
//! tree) and submits it via `gpu.submit`. The runtime parses that payload and
//! hands the `Frame` to the host (which feeds it to the
//! [`Renderer`](elpa_renderer::Renderer)).
//!
//! ```text
//!   execute ─▶ VM pauses on askHost ─▶ dispatch(apiName, payload)
//!      ▲                                       │
//!      └─────────── continue_execution ◀───────┘
//! ```

use elpa_protocol::{Frame, HostCall};
use elpian_vm::api;

/// A handle to one running application VM.
pub struct Runtime {
    machine_id: String,
    cb_counter: i64,
    /// The most recently submitted frame, retained for inspection/diagnostics.
    pub last_frame: Option<Frame>,
}

impl Runtime {
    /// Register a VM from an Elpian AST JSON program.
    pub fn from_ast(machine_id: impl Into<String>, ast_json: &str) -> Option<Runtime> {
        let machine_id = machine_id.into();
        if api::create_vm_from_ast(machine_id.clone(), ast_json.to_string()) {
            Some(Runtime { machine_id, cb_counter: 0, last_frame: None })
        } else {
            None
        }
    }

    /// Run the top-level program, servicing host calls until the VM finishes.
    /// Each submitted frame is surfaced via `on_frame` (the host renders it).
    pub fn run<F: FnMut(&Frame)>(&mut self, mut on_frame: F) -> String {
        let mut result = api::execute_vm(self.machine_id.clone());
        loop {
            if !result.has_host_call {
                return result.result_value;
            }
            let reply = self.dispatch(&result.host_call_data, &mut on_frame);
            result = api::continue_execution(self.machine_id.clone(), reply);
        }
    }

    /// Invoke a VM function with a JSON input (e.g. an input event), draining any
    /// frames it submits.
    pub fn call<F: FnMut(&Frame)>(
        &mut self,
        func: &str,
        input_json: &str,
        mut on_frame: F,
    ) -> String {
        self.cb_counter += 1;
        let mut result = api::execute_vm_func_with_input(
            self.machine_id.clone(),
            func.to_string(),
            input_json.to_string(),
            self.cb_counter,
        );
        loop {
            if !result.has_host_call {
                return result.result_value;
            }
            let reply = self.dispatch(&result.host_call_data, &mut on_frame);
            result = api::continue_execution(self.machine_id.clone(), reply);
        }
    }

    /// Route one host call. `gpu.submit` is surfaced as a parsed [`Frame`];
    /// other calls get best-effort acknowledgement so the VM proceeds.
    fn dispatch<F: FnMut(&Frame)>(&mut self, host_call_data: &str, on_frame: &mut F) -> String {
        let call = match HostCall::parse(host_call_data) {
            Ok(c) => c,
            Err(_) => return ok_null(),
        };
        match call.api_name.as_str() {
            "gpu.submit" => {
                if let Ok(frame) = parse_frame_payload(&call.payload) {
                    on_frame(&frame);
                    self.last_frame = Some(frame);
                }
                ok_null()
            }
            "log" => ok_null(),
            // gpu.writeBuffer/writeTexture/readBuffer/surfaceInfo are serviced by
            // the windowing host; acknowledged here so execution continues.
            _ => ok_null(),
        }
    }
}

/// The VM wraps `askHost` arguments in a JSON array, so a `gpu.submit` payload is
/// `[<frame>]`. Unwrap the array (if present) before parsing the [`Frame`].
fn parse_frame_payload(payload: &str) -> Result<Frame, serde_json::Error> {
    let v: serde_json::Value = serde_json::from_str(payload)?;
    let frame_value = match v {
        serde_json::Value::Array(mut items) if !items.is_empty() => items.remove(0),
        other => other,
    };
    serde_json::from_value(frame_value)
}

fn ok_null() -> String {
    r#"{"type":"null","data":{"value":null}}"#.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_array_wrapped_frame_payload() {
        let payload = r#"[{"commands":[]}]"#;
        let f = parse_frame_payload(payload).unwrap();
        assert!(f.commands.is_empty());
    }
}
