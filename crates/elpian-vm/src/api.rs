//! Embedding API for the Elpian VM.
//!
//! This is a renderer-agnostic port of the original Elpian `api/mod.rs`. It
//! keeps the VM registry and the pause/resume host-call protocol, but drops the
//! old Bevy/Flutter coupling. The set of host API names advertised here is the
//! contract the embedding `elpa-runtime` is expected to service.
//!
//! ## Host-call protocol
//!
//! 1. The embedder creates a VM ([`create_vm_from_ast`]) and starts it
//!    ([`execute_vm`] / [`execute_vm_func`]).
//! 2. When user code calls `askHost(apiName, payload)`, the VM pauses and the
//!    returned [`VmExecResult`] has `has_host_call == true`. `host_call_data` is
//!    a JSON string `{"machineId", "apiName", "payload"}`.
//! 3. The embedder performs the side effect (e.g. hands `payload` to the
//!    renderer when `apiName == "render"`), then resumes with
//!    [`continue_execution`], passing a typed JSON value back as the call's
//!    return value.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::sdk::compiler;
use crate::sdk::vm::VM;

/// Thread-safe registry of live VMs keyed by `machineId`.
static VMS: Lazy<Mutex<HashMap<String, VM>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Host APIs the Elpa runtime is expected to service. The VM itself implements
/// none of these — it only forwards `askHost` calls. `render` is the central
/// one for the UI: it carries the full UI-tree JSON down to the renderer.
///
/// The `canvas.*` family mirrors the HTML5 Canvas 2D API and is the low-level
/// immediate-mode drawing surface; `dom.*` is the retained UI-tree mutation
/// API. Both ultimately resolve to draw commands inside the renderer (see
/// `PLAN.md` §"Drawing Management Layer").
fn all_host_apis() -> Vec<String> {
    [
        // Core runtime
        "println",
        "stringify",
        "render",
        "updateApp",
        // Retained UI-tree (DOM-like) mutation API
        "dom.getElementById",
        "dom.querySelector",
        "dom.querySelectorAll",
        "dom.createElement",
        "dom.removeElement",
        "dom.setTextContent",
        "dom.setAttribute",
        "dom.getAttribute",
        "dom.setStyle",
        "dom.setStyleObject",
        "dom.addClass",
        "dom.removeClass",
        "dom.appendChild",
        "dom.insertBefore",
        "dom.removeChild",
        "dom.addEventListener",
        "dom.removeEventListener",
        "dom.toJson",
        // Immediate-mode canvas (Canvas 2D-compatible) drawing API
        "canvas.addCommand",
        "canvas.addCommands",
        "canvas.clear",
        "canvas.beginPath",
        "canvas.closePath",
        "canvas.moveTo",
        "canvas.lineTo",
        "canvas.quadraticCurveTo",
        "canvas.bezierCurveTo",
        "canvas.arc",
        "canvas.ellipse",
        "canvas.rect",
        "canvas.roundRect",
        "canvas.circle",
        "canvas.fillRect",
        "canvas.strokeRect",
        "canvas.clearRect",
        "canvas.fillText",
        "canvas.strokeText",
        "canvas.drawImage",
        "canvas.fill",
        "canvas.stroke",
        "canvas.clip",
        "canvas.save",
        "canvas.restore",
        "canvas.translate",
        "canvas.rotate",
        "canvas.scale",
        "canvas.transform",
        "canvas.setTransform",
        "canvas.resetTransform",
        "canvas.setFillStyle",
        "canvas.setStrokeStyle",
        "canvas.setLineWidth",
        "canvas.setFont",
        "canvas.setGlobalAlpha",
        "canvas.createLinearGradient",
        "canvas.createRadialGradient",
        "canvas.addColorStop",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Result of a VM execution step.
///
/// When the VM needs to call a host function it pauses and reports the request
/// here. The embedder services it and calls [`continue_execution`].
#[derive(Debug, Clone)]
pub struct VmExecResult {
    /// Whether the VM is paused waiting for a host-call response.
    pub has_host_call: bool,
    /// JSON of the host-call request: `{"machineId", "apiName", "payload"}`.
    pub host_call_data: String,
    /// Stringified result value (only meaningful when `has_host_call == false`).
    pub result_value: String,
}

impl VmExecResult {
    fn host_call(data: String) -> Self {
        VmExecResult { has_host_call: true, host_call_data: data, result_value: String::new() }
    }
    fn done(result_value: &str) -> Self {
        VmExecResult {
            has_host_call: false,
            host_call_data: String::new(),
            result_value: result_value.to_string(),
        }
    }
}

/// After an execution step, surface a pending host call if one was queued.
fn check_host_call(vm: &mut VM, fallback_result: &str) -> VmExecResult {
    if let Some(data) = vm.sending_host_call_data.take() {
        VmExecResult::host_call(data)
    } else {
        VmExecResult::done(fallback_result)
    }
}

/// Initialize the VM subsystem. Call once at startup.
pub fn init_vm_system() {
    drop(VMS.lock().unwrap());
}

/// Create a VM from an Elpian AST JSON string. Returns `false` on parse error.
pub fn create_vm_from_ast(machine_id: String, ast_json: String) -> bool {
    let ast_obj: Value = match serde_json::from_str(&ast_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let vm = VM::compile_and_create_of_ast(machine_id.clone(), ast_obj, 1, all_host_apis());
    VMS.lock().unwrap().insert(machine_id, vm);
    true
}

/// Create a VM directly from Elpian source code (uses the in-VM parser).
pub fn create_vm_from_code(machine_id: String, code: String) -> bool {
    let vm = VM::compile_and_create_of_code(machine_id.clone(), code, 1, all_host_apis());
    VMS.lock().unwrap().insert(machine_id, vm);
    true
}

/// Validate that an AST JSON string compiles, without registering a VM.
pub fn validate_ast(ast_json: String) -> bool {
    let ast_obj: Value = match serde_json::from_str(&ast_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    compiler::compile_ast(ast_obj, 0);
    true
}

/// Execute a VM's top-level program.
pub fn execute_vm(machine_id: String) -> VmExecResult {
    let mut vms = VMS.lock().unwrap();
    match vms.get_mut(&machine_id) {
        Some(vm) if vm.is_exec_processing() => VmExecResult::done("\"vm_busy\""),
        Some(vm) => {
            vm.run();
            check_host_call(vm, "\"done\"")
        }
        None => VmExecResult::done("\"vm_not_found\""),
    }
}

/// Execute a named function (no input). `cb_id` correlates async continuations.
pub fn execute_vm_func(machine_id: String, func_name: String, cb_id: i64) -> VmExecResult {
    let mut vms = VMS.lock().unwrap();
    match vms.get_mut(&machine_id) {
        Some(vm) if vm.is_exec_processing() => VmExecResult::done("\"vm_busy\""),
        Some(vm) => {
            let res = vm.run_func_with_input(&func_name, None, cb_id);
            check_host_call(vm, &res.stringify())
        }
        None => VmExecResult::done("\"vm_not_found\""),
    }
}

/// Execute a named function with a JSON input payload (e.g. an event object).
pub fn execute_vm_func_with_input(
    machine_id: String,
    func_name: String,
    input_json: String,
    cb_id: i64,
) -> VmExecResult {
    let mut vms = VMS.lock().unwrap();
    match vms.get_mut(&machine_id) {
        Some(vm) if vm.is_exec_processing() => VmExecResult::done("\"vm_busy\""),
        Some(vm) => {
            let res = vm.run_func_with_input(&func_name, Some(&input_json), cb_id);
            check_host_call(vm, &res.stringify())
        }
        None => VmExecResult::done("\"vm_not_found\""),
    }
}

/// Resume a VM after a host call, injecting the call's return value.
/// `input_json` is a typed value like `{"type":"string","data":{"value":"ok"}}`.
pub fn continue_execution(machine_id: String, input_json: String) -> VmExecResult {
    let mut vms = VMS.lock().unwrap();
    match vms.get_mut(&machine_id) {
        Some(vm) => {
            vm.continue_run(input_json);
            check_host_call(vm, "\"done\"")
        }
        None => VmExecResult::done("\"vm_not_found\""),
    }
}

/// Destroy a VM and free its resources.
pub fn destroy_vm(machine_id: String) -> bool {
    VMS.lock().unwrap().remove(&machine_id).is_some()
}

/// Whether a VM with this id is registered.
pub fn vm_exists(machine_id: String) -> bool {
    VMS.lock().unwrap().contains_key(&machine_id)
}

/// Compile source to bytecode and report its length (debug aid).
pub fn compile_code_to_info(code: String) -> String {
    let bytecode = compiler::compile_code(code);
    json!({ "bytecodeLength": bytecode.len() }).to_string()
}
