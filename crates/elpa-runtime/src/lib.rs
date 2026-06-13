//! # elpa-runtime
//!
//! The glue that turns the renderer-agnostic VM and the VM-agnostic renderer
//! into a running application. It owns the **host-call dispatch loop**:
//!
//! ```text
//!   execute ──▶ VM pauses on askHost ──▶ dispatch(apiName, payload)
//!      ▲                                        │
//!      └──────────── continue_execution ◀───────┘   (until done)
//! ```
//!
//! The most important call it services is `render`: it parses the UI-tree
//! payload into [`elpa_protocol::UiTree`] and hands it to the host application
//! (which lays it out, lowers it to a `DrawList`, and feeds the
//! `DrawingManager`). Input events are pushed back into the VM by invoking the
//! bound handler function with the event payload.
//!
//! This crate deliberately stops at producing a `UiTree` + side-effect hooks;
//! layout/lowering and the windowing host live above it (see `PLAN.md`).

use elpa_protocol::{HostCall, UiTree};
use elpian_vm::api;

/// Outcome of pumping the VM until it next blocks or finishes.
#[derive(Debug)]
pub enum Pump {
    /// The VM ran to completion for this turn.
    Done(String),
    /// A new UI tree was produced and should be rendered.
    Render(UiTree),
}

/// A handle to one running application VM plus the host-side state needed to
/// service its calls.
pub struct Runtime {
    machine_id: String,
    cb_counter: i64,
    /// The latest UI tree the app rendered, retained for event hit-testing and
    /// for diffing against the next render.
    pub last_tree: Option<UiTree>,
}

impl Runtime {
    /// Register a new VM from an Elpian AST JSON program and return its handle.
    pub fn from_ast(machine_id: impl Into<String>, ast_json: &str) -> Option<Runtime> {
        let machine_id = machine_id.into();
        if api::create_vm_from_ast(machine_id.clone(), ast_json.to_string()) {
            Some(Runtime { machine_id, cb_counter: 0, last_tree: None })
        } else {
            None
        }
    }

    /// Run the top-level program, servicing host calls until the VM blocks or
    /// finishes. Returns each `render` as it happens via `on_render`; the host
    /// app supplies the side effect (layout + draw). Non-render calls are
    /// handled internally and acknowledged.
    pub fn run<F: FnMut(&UiTree)>(&mut self, mut on_render: F) -> String {
        let mut result = api::execute_vm(self.machine_id.clone());
        loop {
            if !result.has_host_call {
                return result.result_value;
            }
            let reply = self.dispatch(&result.host_call_data, &mut on_render);
            result = api::continue_execution(self.machine_id.clone(), reply);
        }
    }

    /// Deliver an input event to a bound handler (e.g. the function named in a
    /// node's `events.click`). `event_json` is the event object. Drains any host
    /// calls — typically a re-`render` — the handler triggers.
    pub fn dispatch_event<F: FnMut(&UiTree)>(
        &mut self,
        handler: &str,
        event_json: &str,
        mut on_render: F,
    ) -> String {
        self.cb_counter += 1;
        let mut result = api::execute_vm_func_with_input(
            self.machine_id.clone(),
            handler.to_string(),
            event_json.to_string(),
            self.cb_counter,
        );
        loop {
            if !result.has_host_call {
                return result.result_value;
            }
            let reply = self.dispatch(&result.host_call_data, &mut on_render);
            result = api::continue_execution(self.machine_id.clone(), reply);
        }
    }

    /// Route one host call. `render` is surfaced to the host via `on_render`;
    /// everything else gets a best-effort built-in handling. The returned string
    /// is the typed value injected back as the call's return value.
    fn dispatch<F: FnMut(&UiTree)>(&mut self, host_call_data: &str, on_render: &mut F) -> String {
        let call = match HostCall::parse(host_call_data) {
            Ok(c) => c,
            Err(_) => return ok_null(),
        };
        match call.api_name.as_str() {
            "render" => {
                if let Ok(tree) = UiTree::parse(&call.payload) {
                    on_render(&tree);
                    self.last_tree = Some(tree);
                }
                ok_null()
            }
            "println" => {
                // Host log sink; payload is the stringified argument.
                ok_null()
            }
            "stringify" => {
                // Echo the payload back as a string value.
                typed_string(&call.payload)
            }
            // canvas.* / dom.* are serviced by the renderer-side adapters in the
            // windowing host; acknowledge here so the VM proceeds.
            _ => ok_null(),
        }
    }
}

/// The VM's typed-null return value.
fn ok_null() -> String {
    r#"{"type":"null","data":{"value":null}}"#.to_string()
}

/// Wrap a raw string as the VM's typed-string return value.
fn typed_string(s: &str) -> String {
    serde_json::json!({ "type": "string", "data": { "value": s } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_helpers_are_valid_json() {
        assert!(serde_json::from_str::<serde_json::Value>(&ok_null()).is_ok());
        let s = typed_string("a\"b");
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["data"]["value"], "a\"b");
    }
}
