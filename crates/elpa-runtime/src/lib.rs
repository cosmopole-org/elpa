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

use elpa_protocol::{Definition, Frame, HostCall, Layer};
use elpian_vm::api;

pub mod definitions;
pub mod host_env;
pub mod media;
pub mod scope;
pub use definitions::{DefinitionStore, ExpandError};
pub use media::{MediaFetcher, MediaFrame, MediaSource, MediaState};
pub use scope::{LayerStore, ScopeStats};
pub use host_env::{
    ClosureNet, DeniedNet, EnvToggles, FileStat, FileStore, HostEnv, MemoryFileStore, NativeFileStore,
    NetProvider, NetRequest, NetResponse,
};

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

    /// Register a VM from JavaScript source. The JS is lowered to Elpian AST
    /// JSON by the VM's built-in front-end and then compiled through the same
    /// path as [`Runtime::from_ast`]. Returns `None` if the source is outside
    /// the supported JS subset.
    pub fn from_js(machine_id: impl Into<String>, js_source: &str) -> Option<Runtime> {
        let machine_id = machine_id.into();
        if api::create_vm_from_js(machine_id.clone(), js_source.to_string()) {
            Some(Runtime { machine_id, cb_counter: 0 })
        } else {
            None
        }
    }

    pub fn machine_id(&self) -> &str {
        &self.machine_id
    }

    /// Destroy the underlying VM, freeing its slot in the registry. Used for
    /// transient VMs (e.g. an imported module run once to register definitions).
    pub fn dispose(&self) {
        api::destroy_vm(self.machine_id.clone());
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
///
/// On native targets this uses simd-json for SIMD-accelerated parsing; on
/// wasm32 it falls back to serde_json (no SIMD intrinsics available there).
pub fn frame_from_submit(call: &HostCall) -> Option<Frame> {
    if call.api_name != "gpu.submit" {
        return None;
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        // simd-json mutates its input buffer in place for speed, so we need an
        // owned byte vec. The VM wraps arguments in a one-element array normally.
        let mut buf = call.payload.as_bytes().to_vec();
        if let Ok(mut frames) = simd_json::from_slice::<Vec<Frame>>(&mut buf) {
            if !frames.is_empty() {
                return Some(frames.remove(0));
            }
        }
        let mut buf2 = call.payload.as_bytes().to_vec();
        simd_json::from_slice::<Frame>(&mut buf2).ok()
    }

    #[cfg(target_arch = "wasm32")]
    {
        if let Ok(mut frames) = serde_json::from_str::<Vec<Frame>>(&call.payload) {
            if !frames.is_empty() {
                return Some(frames.remove(0));
            }
        }
        serde_json::from_str::<Frame>(&call.payload).ok()
    }
}

/// Unwrap the single argument of an `askHost` payload. The VM wraps call
/// arguments in a JSON array (`[arg0, …]`); host APIs here take one argument, so
/// this returns `arg0` (or the payload itself if it isn't an array).
fn first_arg(payload: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    match v {
        serde_json::Value::Array(mut items) if !items.is_empty() => Some(items.remove(0)),
        serde_json::Value::Array(_) => None,
        other => Some(other),
    }
}

/// Parse a `gpu.define` host call's payload into a [`Definition`] to register.
pub fn definition_from_define(call: &HostCall) -> Option<Definition> {
    if call.api_name != "gpu.define" {
        return None;
    }
    serde_json::from_value(first_arg(&call.payload)?).ok()
}

/// Parse the target id of a `gpu.undefine` host call. Accepts either a bare
/// string id (`["myShape"]`) or an object (`[{"id":"myShape"}]`).
pub fn undefine_target(call: &HostCall) -> Option<String> {
    if call.api_name != "gpu.undefine" {
        return None;
    }
    match first_arg(&call.payload)? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(map) => {
            map.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
        }
        _ => None,
    }
}

/// Parse a `scope.define` host call's payload into a [`Layer`] to register.
pub fn layer_from_define(call: &HostCall) -> Option<Layer> {
    if call.api_name != "scope.define" {
        return None;
    }
    serde_json::from_value(first_arg(&call.payload)?).ok()
}

/// Parse the target id of a `scope.invalidate` / `scope.release` host call.
/// Accepts either a bare string id (`["drawer"]`) or an object
/// (`[{"id":"drawer"}]`), mirroring [`undefine_target`].
pub fn scope_target(call: &HostCall) -> Option<String> {
    if call.api_name != "scope.invalidate" && call.api_name != "scope.release" {
        return None;
    }
    match first_arg(&call.payload)? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(map) => {
            map.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
        }
        _ => None,
    }
}

/// A request to import an external Elpian module, parsed from a `vm.import` call.
///
/// The argument is either a bare source string (`["assets/shapes.json"]`) or an
/// object that may carry a `source` to resolve, an inline `ast` to run directly,
/// and an optional `id` for diagnostics: `[{"source":"…","id":"shapes"}]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportRequest {
    pub id: Option<String>,
    pub source: Option<String>,
    pub ast: Option<serde_json::Value>,
}

/// Parse a `vm.import` host call into an [`ImportRequest`].
pub fn import_request(call: &HostCall) -> Option<ImportRequest> {
    if call.api_name != "vm.import" {
        return None;
    }
    match first_arg(&call.payload)? {
        serde_json::Value::String(s) => {
            Some(ImportRequest { source: Some(s), ..Default::default() })
        }
        serde_json::Value::Object(map) => Some(ImportRequest {
            id: map.get("id").and_then(|v| v.as_str()).map(String::from),
            source: map.get("source").and_then(|v| v.as_str()).map(String::from),
            ast: map.get("ast").cloned(),
        }),
        _ => None,
    }
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

    #[test]
    fn definition_from_define_unwraps_arg() {
        let call = HostCall {
            machine_id: "m".into(),
            api_name: "gpu.define".into(),
            payload: r#"[{"id":"quad","level":"render","commands":[{"cmd":"draw","vertex_count":6}]}]"#
                .into(),
        };
        let def = definition_from_define(&call).unwrap();
        assert_eq!(def.id, "quad");
    }

    #[test]
    fn undefine_target_accepts_string_or_object() {
        let s = HostCall {
            machine_id: "m".into(),
            api_name: "gpu.undefine".into(),
            payload: r#"["quad"]"#.into(),
        };
        assert_eq!(undefine_target(&s).as_deref(), Some("quad"));
        let o = HostCall { payload: r#"[{"id":"quad"}]"#.into(), ..s };
        assert_eq!(undefine_target(&o).as_deref(), Some("quad"));
    }

    #[test]
    fn layer_from_define_unwraps_arg() {
        let call = HostCall {
            machine_id: "m".into(),
            api_name: "scope.define".into(),
            payload: r#"[{"id":"drawer","width":1080,"height":2340,"commands":[]}]"#.into(),
        };
        let layer = layer_from_define(&call).unwrap();
        assert_eq!(layer.id, "drawer");
        assert_eq!(layer.texture_id(), "elpa.layer.drawer.tex");
    }

    #[test]
    fn scope_target_accepts_string_or_object() {
        let s = HostCall {
            machine_id: "m".into(),
            api_name: "scope.invalidate".into(),
            payload: r#"["drawer"]"#.into(),
        };
        assert_eq!(scope_target(&s).as_deref(), Some("drawer"));
        let o = HostCall {
            api_name: "scope.release".into(),
            payload: r#"[{"id":"drawer"}]"#.into(),
            ..s
        };
        assert_eq!(scope_target(&o).as_deref(), Some("drawer"));
    }

    #[test]
    fn import_request_parses_source_and_inline_ast() {
        let src = HostCall {
            machine_id: "m".into(),
            api_name: "vm.import".into(),
            payload: r#"["assets/shapes.json"]"#.into(),
        };
        assert_eq!(import_request(&src).unwrap().source.as_deref(), Some("assets/shapes.json"));

        let inline = HostCall {
            machine_id: "m".into(),
            api_name: "vm.import".into(),
            payload: r#"[{"id":"shapes","ast":{"type":"program","body":[]}}]"#.into(),
        };
        let req = import_request(&inline).unwrap();
        assert_eq!(req.id.as_deref(), Some("shapes"));
        assert!(req.ast.is_some());
    }
}
