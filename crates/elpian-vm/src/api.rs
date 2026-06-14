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

/// Host APIs the Elpa runtime services. The VM implements none of these — it
/// only forwards `askHost` calls. Elpa is a *programmable VM around the wgpu
/// API*: there is **no** widget/DOM/canvas abstraction. The app's JS emits a
/// nested JSON tree of wgpu commands and submits it; Elpa maps that tree to the
/// wgpu API in real time (see `PLAN.md`).
///
/// The surface is intentionally tiny:
/// * `gpu.submit` — hand the renderer one frame's wgpu command tree
///   (`elpa_protocol::Frame`: resources + encoder commands). This is the central
///   call and the only one strictly required.
/// * `gpu.writeBuffer` / `gpu.writeTexture` — stream data into an existing GPU
///   resource without re-submitting the whole tree (queue writes).
/// * `gpu.readBuffer` — async GPU→CPU readback (resolves on a later continue).
/// * `gpu.surfaceInfo` — query the current surface size/format/scale factor.
/// * `gpu.define` / `gpu.undefine` — register / unregister a reusable drawing
///   definition (a named batch of commands, 2D and/or 3D) in the host's store,
///   so later `gpu.submit` frames can reference it abstractly by id instead of
///   re-emitting its command tree. Definitions may reference other definitions,
///   composing complex drawings from simpler ones and keeping payloads tiny.
/// * `vm.import` — import an external Elpian module (from a project asset or the
///   network) and run it so it can register definitions, expanding the engine's
///   drawing vocabulary at runtime.
/// * `log` — diagnostics.
fn all_host_apis() -> Vec<String> {
    // Every native host name the VM may emit must appear here, or a call to it
    // is not treated as a native `askHost` target.
    [
        "log",
        "gpu.submit",
        "gpu.writeBuffer",
        "gpu.writeTexture",
        "gpu.readBuffer",
        "gpu.surfaceInfo",
        "gpu.define",
        "gpu.undefine",
        "vm.import",
        // Capability-gated environmental interfaces. Each family is toggled by
        // the host via the instance's capability set; a disabled family makes
        // the corresponding `askHost` short-circuit to null (see executor).
        "net.fetch",
        "net.open",
        "net.send",
        "net.recv",
        "net.close",
        "fs.read",
        "fs.write",
        "fs.append",
        "fs.delete",
        "fs.list",
        "fs.exists",
        "fs.stat",
        "fs.mkdir",
        "time.now",
        "time.monotonic",
        "random.next",
        "random.bytes",
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

// ----------------------------------------------------------------------------
// Instance control: resource limits, capabilities, and lifecycle.
//
// The host steers a registered VM entirely through these functions, keyed by
// `machine_id`. They are the embedder-facing contract for the unified governance
// and lifecycle system: cap an instance's CPU/heap/storage, switch its
// environmental interfaces on and off, and pause / resume / terminate it.
// ----------------------------------------------------------------------------

pub use crate::sdk::capabilities::{Capability, CapabilitySet};
pub use crate::sdk::lifecycle::RunState;
pub use crate::sdk::limits::{ResourceLimits, ResourceUsage};

/// Apply a resource-limit policy to a registered VM. Returns `false` if unknown.
pub fn set_limits(machine_id: &str, limits: ResourceLimits) -> bool {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => {
            vm.set_limits(limits);
            true
        }
        None => false,
    }
}

/// Read a VM's live resource usage, if it exists.
pub fn usage(machine_id: &str) -> Option<ResourceUsage> {
    VMS.lock().unwrap().get(machine_id).map(|vm| vm.usage())
}

/// Toggle one capability (network, storage, clock, …) for a VM.
pub fn set_capability(machine_id: &str, cap: Capability, allowed: bool) -> bool {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => {
            vm.set_capability(cap, allowed);
            true
        }
        None => false,
    }
}

/// Replace a VM's whole capability set (e.g. install a sandbox `deny_all`).
pub fn set_capabilities(machine_id: &str, caps: CapabilitySet) -> bool {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => {
            vm.set_capabilities(caps);
            true
        }
        None => false,
    }
}

/// Whether a VM currently permits the given host API.
pub fn capability_allows(machine_id: &str, api_name: &str) -> bool {
    VMS.lock()
        .unwrap()
        .get(machine_id)
        .map(|vm| vm.capabilities().allows_api(api_name))
        .unwrap_or(false)
}

/// Request a pause: the VM suspends at its next interpreter step boundary, with
/// its full continuation preserved for [`resume_execution`].
pub fn pause_vm(machine_id: &str) -> bool {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => {
            vm.request_pause();
            true
        }
        None => false,
    }
}

/// Resume a paused VM, continuing exactly where it suspended.
pub fn resume_execution(machine_id: String) -> VmExecResult {
    let mut vms = VMS.lock().unwrap();
    match vms.get_mut(&machine_id) {
        Some(vm) => {
            let res = vm.resume();
            check_host_call(vm, &res.stringify())
        }
        None => VmExecResult::done("\"vm_not_found\""),
    }
}

/// Request termination: the VM unwinds at its next step boundary and becomes
/// inert. Further drive calls are no-ops.
pub fn terminate_vm(machine_id: &str) -> bool {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => {
            vm.request_terminate();
            true
        }
        None => false,
    }
}

/// Current run state of a VM (running / paused / terminated / …).
pub fn run_state(machine_id: &str) -> Option<RunState> {
    VMS.lock().unwrap().get(machine_id).map(|vm| vm.run_state())
}

/// The fatal trap reason if a VM was stopped by a limit overrun or runtime
/// error, else `None`.
pub fn trap_reason(machine_id: &str) -> Option<String> {
    VMS.lock().unwrap().get(machine_id).and_then(|vm| vm.trap_reason())
}

/// Charge the storage governor on behalf of the host's fabricated filesystem.
/// Returns the limit-error message if the storage cap would be exceeded.
pub fn charge_storage(machine_id: &str, delta: i64) -> Result<(), String> {
    let vms = VMS.lock().unwrap();
    match vms.get(machine_id) {
        Some(vm) => vm.charge_storage(delta),
        None => Err("vm_not_found".to_string()),
    }
}
