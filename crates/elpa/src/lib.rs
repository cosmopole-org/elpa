//! # elpa
//!
//! The unified Elpa instance — a single object that owns and assembles the whole
//! stack: the **VM** (your app logic), the **renderer** (resource cache +
//! partial rendering), and a **GPU backend**. You construct one with a backend
//! and an app AST, then drive it; it re-renders efficiently on every event or
//! app-initiated state change, with the caching/partial-render engine ensuring
//! only what changed reaches the GPU.
//!
//! ```no_run
//! use elpa::{Elpa, SurfaceInfo, InputEvent};
//! use elpa::headless::HeadlessBackend;
//!
//! # let ast_json = "";
//! let surface = SurfaceInfo::new(1920, 1080, 2.0);
//! let mut app = Elpa::new(HeadlessBackend::default(), surface, ast_json).unwrap();
//! app.start();                       // run top-level program (init + first frame)
//! app.send_event(&InputEvent::PointerDown { x: 100.0, y: 200.0, button: 0 });
//! app.resize(1280, 720, 1.5);        // app's `onResize` re-fits and re-submits
//! ```
//!
//! ## The app contract (functions the app may define)
//!
//! * **top-level program** — runs once on [`Elpa::start`]; set up state, build
//!   resources, submit the first frame via `gpu.submit(frame)`.
//! * **`onEvent(e)`** — called for each input event; `e` is `{type, x, y, nx,
//!   ny, button|key|deltaY}`. Mutate state, then `gpu.submit` a new frame.
//! * **`onResize(info)`** — called on surface resize; `info` is the
//!   [`SurfaceInfo`] JSON (physical+logical size, scale, aspect). Re-build size-
//!   dependent resources and re-submit.
//! * **`onFrame(dtMs)`** — called once per animation tick for continuous
//!   animation; submit the next frame.
//!
//! The app reads live surface metrics any time via the `gpu.surfaceInfo` host
//! call, so its coordinates/aspect adapt to phone, tablet, and desktop screens.

pub mod event;
pub mod headless;
pub mod surface;

pub use event::InputEvent;
pub use headless::HeadlessBackend;
pub use surface::SurfaceInfo;

// Re-export the core types a host/example needs.
pub use elpa_protocol::{self as protocol, Definition, DefinitionBody, Frame};
pub use elpa_renderer::{FrameStats, GpuBackend, Renderer};
pub use elpa_runtime::DefinitionStore;

#[cfg(feature = "wgpu")]
pub use elpa_renderer::wgpu_backend::WgpuBackend;

use ahash::AHashMap as HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use elpa_runtime::{
    definition_from_define, frame_from_submit, import_request, reply_json, reply_null,
    undefine_target, HostEnv, Runtime, Start,
};

// Re-export the instance-governance surface so a host can cap, gate, and steer
// an app through the `elpa` crate without reaching into `elpian-vm` directly.
pub use elpian_vm::api::{Capability, CapabilitySet, ResourceLimits, ResourceUsage, RunState};
// Lower JavaScript source to Elpian AST JSON (tooling aid — e.g. validating an
// embedded WGSL shader in a JS-authored module without running it).
pub use elpian_vm::api::compile_js_to_ast;
pub use elpa_runtime::{
    ClosureNet, EnvToggles, FileStore, MemoryFileStore, NativeFileStore, NetProvider, NetRequest,
    NetResponse,
};

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);
static IMPORT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A hook the embedder can install to resolve an external module `source` (that
/// is not in the bundled asset map) to its Elpian AST JSON — e.g. a synchronous
/// network fetch. Returns `None` if the source cannot be resolved.
pub type AssetFetcher = Box<dyn Fn(&str) -> Option<String>>;

/// One running Elpa application: VM + renderer + backend, assembled and managed
/// together. Generic over the [`GpuBackend`] so the same instance logic drives
/// real wgpu in production and [`HeadlessBackend`] in tests.
pub struct Elpa<B: GpuBackend> {
    runtime: Runtime,
    renderer: Renderer<B>,
    surface: SurfaceInfo,
    last_frame: Option<Frame>,
    last_stats: FrameStats,
    log: Vec<String>,
    /// Registered reusable drawing definitions (the `gpu.define` store). Submitted
    /// frames are expanded against this before they reach the renderer.
    defs: DefinitionStore,
    /// Bundled external Elpian modules, keyed by the `source` string `vm.import`
    /// references (e.g. a project asset path). Populated by the embedder.
    assets: HashMap<String, String>,
    /// Optional resolver for `vm.import` sources not found in `assets`.
    fetcher: Option<AssetFetcher>,
    /// Host-side environmental interfaces (fabricated filesystem, networking,
    /// clock, randomness) servicing the VM's capability-gated `fs.*`/`net.*`/
    /// `time.*`/`random.*` calls. Togglable and bounded; see [`HostEnv`].
    env: HostEnv,
}

impl<B: GpuBackend> Elpa<B> {
    /// Assemble an instance from a GPU backend, the initial surface geometry, and
    /// an Elpian AST JSON program. Returns `None` if the AST fails to compile.
    pub fn new(backend: B, surface: SurfaceInfo, ast_json: &str) -> Option<Self> {
        let id = format!("elpa-{}", INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed));
        let runtime = Runtime::from_ast(id, ast_json)?;
        Some(Self::with_runtime(runtime, backend, surface))
    }

    /// Assemble an instance from a GPU backend, the initial surface geometry, and
    /// an app written in **JavaScript**. The JS is lowered to the very same
    /// Elpian AST by the VM's built-in front-end and compiled through the same
    /// path as [`Elpa::new`] — so an app authored in JS is a first-class peer of
    /// one shipped as hand-written AST. Returns `None` if the source is outside
    /// the supported JS subset (i.e. it fails to parse / compile).
    pub fn new_from_js(backend: B, surface: SurfaceInfo, js_source: &str) -> Option<Self> {
        let id = format!("elpa-{}", INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed));
        let runtime = Runtime::from_js(id, js_source)?;
        Some(Self::with_runtime(runtime, backend, surface))
    }

    /// Shared field initialization for the AST and JS constructors.
    fn with_runtime(runtime: Runtime, backend: B, surface: SurfaceInfo) -> Self {
        Self {
            runtime,
            renderer: Renderer::new(backend),
            surface,
            last_frame: None,
            last_stats: FrameStats::default(),
            log: Vec::new(),
            defs: DefinitionStore::new(),
            assets: HashMap::new(),
            fetcher: None,
            env: HostEnv::default(),
        }
    }

    // ---- Instance governance (limits, capabilities, lifecycle) --------------

    /// Apply a resource-limit policy (instructions / memory / storage / call
    /// depth) to this app's VM.
    pub fn set_limits(&self, limits: ResourceLimits) -> bool {
        elpian_vm::api::set_limits(self.runtime.machine_id(), limits)
    }
    /// Live resource usage for this app.
    pub fn usage(&self) -> Option<ResourceUsage> {
        elpian_vm::api::usage(self.runtime.machine_id())
    }
    /// Toggle a VM capability (network, storage, …). A disabled capability makes
    /// the matching host call short-circuit to null inside the VM.
    pub fn set_capability(&self, cap: Capability, allowed: bool) -> bool {
        elpian_vm::api::set_capability(self.runtime.machine_id(), cap, allowed)
    }
    /// Replace the whole capability set (e.g. a sandbox `deny_all`).
    pub fn set_capabilities(&self, caps: CapabilitySet) -> bool {
        elpian_vm::api::set_capabilities(self.runtime.machine_id(), caps)
    }
    /// Request the VM pause at its next step boundary (continuation preserved).
    pub fn pause(&self) -> bool {
        elpian_vm::api::pause_vm(self.runtime.machine_id())
    }
    /// Resume a paused VM, servicing any host calls it makes as it continues.
    pub fn resume(&mut self) {
        let Elpa { runtime, renderer, surface, last_frame, last_stats, log, defs, assets, fetcher, env } =
            self;
        let mid = runtime.machine_id().to_string();
        let mut result = elpian_vm::api::resume_execution(mid.clone());
        loop {
            if !result.has_host_call {
                break;
            }
            let reply = match elpa_protocol::HostCall::parse(&result.host_call_data) {
                Ok(hc) => handle_call(
                    &hc, renderer, surface, last_frame, last_stats, log, defs, assets, fetcher, env,
                ),
                Err(_) => reply_null(),
            };
            result = elpian_vm::api::continue_execution(mid.clone(), reply);
        }
    }
    /// Request the VM terminate; it becomes inert.
    pub fn terminate(&self) -> bool {
        elpian_vm::api::terminate_vm(self.runtime.machine_id())
    }
    /// Current run state (running / paused / terminated / …).
    pub fn run_state(&self) -> Option<RunState> {
        elpian_vm::api::run_state(self.runtime.machine_id())
    }
    /// The fatal trap reason if a limit overrun or runtime error stopped the VM.
    pub fn trap_reason(&self) -> Option<String> {
        elpian_vm::api::trap_reason(self.runtime.machine_id())
    }

    /// The host environment (fabricated filesystem, networking, clock,
    /// randomness). Use it to install backends and flip interface toggles.
    pub fn env(&self) -> &HostEnv {
        &self.env
    }
    pub fn env_mut(&mut self) -> &mut HostEnv {
        &mut self.env
    }

    /// Bundle an external Elpian module so the app can `vm.import` it by
    /// `source`. `ast_json` is an Elpian AST program; when imported it is run
    /// once and may register drawing definitions (via `gpu.define`) that the app
    /// then references. This is how the engine's drawing vocabulary is expanded
    /// from project assets without recompiling the app.
    pub fn register_asset(&mut self, source: impl Into<String>, ast_json: impl Into<String>) {
        self.assets.insert(source.into(), ast_json.into());
    }

    /// Install a resolver for `vm.import` sources that are not bundled assets
    /// (e.g. fetched from the network). Called with the requested `source`.
    pub fn set_fetcher(&mut self, fetcher: impl Fn(&str) -> Option<String> + 'static) {
        self.fetcher = Some(Box::new(fetcher));
    }

    /// Register a drawing definition directly from the Rust host (the same store
    /// `gpu.define` writes to). Useful for seeding engine primitives at startup.
    pub fn define(&mut self, def: Definition) {
        self.defs.register(def);
    }

    /// Unregister a definition by id. Returns whether one was present.
    pub fn undefine(&mut self, id: &str) -> bool {
        self.defs.unregister(id)
    }

    /// The current definition store (count/lookup of registered drawings).
    pub fn definitions(&self) -> &DefinitionStore {
        &self.defs
    }

    /// Import and run an Elpian module directly from the host, registering
    /// whatever definitions it declares. The `source` may be either Elpian AST
    /// JSON or **JavaScript** source — it is compiled through whichever front-end
    /// accepts it. Equivalent to the app calling `vm.import` with an inline
    /// module. Returns whether the module compiled.
    pub fn import_ast(&mut self, ast_json: &str) -> bool {
        let id = format!("elpa-import-{}", IMPORT_COUNTER.fetch_add(1, Ordering::Relaxed));
        let Elpa { renderer, surface, last_frame, last_stats, log, defs, assets, fetcher, env, .. } =
            self;
        match runtime_from_source(id, ast_json) {
            Some(mut rt) => {
                pump_vm(
                    &mut rt, Start::Main, renderer, surface, last_frame, last_stats, log, defs,
                    assets, fetcher, env,
                );
                rt.dispose();
                true
            }
            None => false,
        }
    }

    /// Run the app's top-level program (initialization + first frame).
    pub fn start(&mut self) {
        self.drive(Start::Main);
    }

    /// Forward an input event to the app's `onEvent`, rendering any frame it
    /// submits in response.
    pub fn send_event(&mut self, event: &InputEvent) {
        let input = event.to_json(&self.surface).to_string();
        self.drive(Start::Func { name: "onEvent", input: &input });
    }

    /// Advance one animation tick, calling the app's `onFrame(dtMs)`.
    pub fn animate(&mut self, dt_ms: f64) {
        let input = serde_json::json!(dt_ms).to_string();
        self.drive(Start::Func { name: "onFrame", input: &input });
    }

    /// Handle a surface resize: update geometry, invalidate caches (old textures
    /// no longer fit), and notify the app via `onResize` so it can re-fit and
    /// re-submit. The host is still responsible for reconfiguring the wgpu
    /// surface on its backend before the next present.
    pub fn resize(&mut self, width: u32, height: u32, scale_factor: f64) {
        self.surface = SurfaceInfo::new(width, height, scale_factor);
        self.renderer.invalidate();
        let input = self.surface.to_json().to_string();
        self.drive(Start::Func { name: "onResize", input: &input });
    }

    pub fn surface_info(&self) -> SurfaceInfo {
        self.surface
    }

    /// Work report for the most recent rendered frame (cache hits/misses, etc.).
    pub fn last_stats(&self) -> &FrameStats {
        &self.last_stats
    }

    pub fn last_frame(&self) -> Option<&Frame> {
        self.last_frame.as_ref()
    }

    /// Drained app log lines (from the `log` host call).
    pub fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }

    pub fn renderer(&self) -> &Renderer<B> {
        &self.renderer
    }
    pub fn renderer_mut(&mut self) -> &mut Renderer<B> {
        &mut self.renderer
    }

    /// Pump the VM for one turn, routing host calls (see [`handle_call`]).
    fn drive(&mut self, start: Start) {
        // Disjoint borrows of the instance's fields for the dispatch closure.
        let Elpa {
            runtime, renderer, surface, last_frame, last_stats, log, defs, assets, fetcher, env,
        } = self;
        pump_vm(
            runtime, start, renderer, surface, last_frame, last_stats, log, defs, assets, fetcher,
            env,
        );
    }
}

/// Compile a module `source` that may be **either** Elpian AST JSON or
/// JavaScript: try the AST front-end first (the source is valid JSON), and on
/// failure fall back to the JS front-end. JS source is never valid AST JSON, so
/// the two are unambiguous and the fallback is free. This is what lets both the
/// app and any `vm.import`ed module be authored in JS.
fn runtime_from_source(id: String, source: &str) -> Option<Runtime> {
    Runtime::from_ast(id.clone(), source).or_else(|| Runtime::from_js(id, source))
}

/// Drive one VM (the app, or an imported module) through a pump turn, routing
/// every host call through [`handle_call`] with the shared instance state.
///
/// Factored as a free function over explicit `&mut` parameters (rather than a
/// method) so that `vm.import` can run a *nested* VM with the same routing and
/// the same definition store / renderer, without the borrow conflict a second
/// `&mut self` reentry would cause.
#[allow(clippy::too_many_arguments)]
fn pump_vm<B: GpuBackend>(
    rt: &mut Runtime,
    start: Start,
    renderer: &mut Renderer<B>,
    surface: &SurfaceInfo,
    last_frame: &mut Option<Frame>,
    last_stats: &mut FrameStats,
    log: &mut Vec<String>,
    defs: &mut DefinitionStore,
    assets: &HashMap<String, String>,
    fetcher: &Option<AssetFetcher>,
    env: &mut HostEnv,
) {
    rt.pump(start, |hc| {
        handle_call(hc, renderer, surface, last_frame, last_stats, log, defs, assets, fetcher, env)
    });
}

/// Service one host call against the shared instance state and return the reply.
///
/// * `gpu.submit` — **expand** the frame against the definition store (resolving
///   every `useDefinition` reference into a flat command tree), then render it.
/// * `gpu.define` / `gpu.undefine` — register / unregister a reusable drawing.
/// * `vm.import` — resolve an external module (inline `ast`, bundled asset, or
///   `fetcher`) and run it through a nested pump so its `gpu.define` calls land
///   in the *same* store the app references.
/// * `gpu.surfaceInfo` / `log` — answered from live state.
#[allow(clippy::too_many_arguments)]
fn handle_call<B: GpuBackend>(
    hc: &elpa_protocol::HostCall,
    renderer: &mut Renderer<B>,
    surface: &SurfaceInfo,
    last_frame: &mut Option<Frame>,
    last_stats: &mut FrameStats,
    log: &mut Vec<String>,
    defs: &mut DefinitionStore,
    assets: &HashMap<String, String>,
    fetcher: &Option<AssetFetcher>,
    env: &mut HostEnv,
) -> String {
    // Environmental interfaces (fs.*, net.*, time.*, random.*) are serviced by
    // the host environment; everything else falls through to the GPU/log/import
    // handlers below.
    if let Some(reply) = env.service(hc) {
        return reply;
    }
    match hc.api_name.as_str() {
        "gpu.submit" => {
            if let Some(frame) = frame_from_submit(hc) {
                match defs.expand(frame) {
                    Ok(flat) => {
                        *last_stats = renderer.render(&flat);
                        *last_frame = Some(flat);
                    }
                    Err(e) => log.push(format!("gpu.submit: {e}")),
                }
            }
            reply_null()
        }
        "gpu.define" => {
            if let Some(def) = definition_from_define(hc) {
                defs.register(def);
            }
            reply_null()
        }
        "gpu.undefine" => {
            if let Some(id) = undefine_target(hc) {
                defs.unregister(&id);
            }
            reply_null()
        }
        "vm.import" => {
            if let Some(req) = import_request(hc) {
                match resolve_module(&req, assets, fetcher) {
                    Some(ast_json) => {
                        let id =
                            format!("elpa-import-{}", IMPORT_COUNTER.fetch_add(1, Ordering::Relaxed));
                        match runtime_from_source(id, &ast_json) {
                            Some(mut rt) => {
                                pump_vm(
                                    &mut rt, Start::Main, renderer, surface, last_frame, last_stats,
                                    log, defs, assets, fetcher, env,
                                );
                                rt.dispose();
                            }
                            None => log.push(format!(
                                "vm.import: module {:?} failed to compile",
                                req.source.as_deref().or(req.id.as_deref()).unwrap_or("<inline>")
                            )),
                        }
                    }
                    None => log.push(format!(
                        "vm.import: could not resolve source {:?}",
                        req.source.as_deref().unwrap_or("<none>")
                    )),
                }
            }
            reply_null()
        }
        "gpu.surfaceInfo" => reply_json(&surface.to_json()),
        "log" => {
            log.push(hc.payload.clone());
            reply_null()
        }
        // gpu.writeBuffer/writeTexture/readBuffer are serviced by the host's
        // backend adapter in a full integration; acknowledged here.
        _ => reply_null(),
    }
}

/// Resolve an [`ImportRequest`](elpa_runtime::ImportRequest) to module AST JSON:
/// an inline `ast` wins; else the `source` is looked up in bundled `assets`;
/// else the optional `fetcher` is consulted.
fn resolve_module(
    req: &elpa_runtime::ImportRequest,
    assets: &HashMap<String, String>,
    fetcher: &Option<AssetFetcher>,
) -> Option<String> {
    if let Some(ast) = &req.ast {
        return Some(ast.to_string());
    }
    let source = req.source.as_deref()?;
    if let Some(ast) = assets.get(source) {
        return Some(ast.clone());
    }
    fetcher.as_ref().and_then(|f| f(source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &str) -> serde_json::Value {
        json!({ "type": "string", "data": { "value": v } })
    }
    fn i(v: i64) -> serde_json::Value {
        json!({ "type": "i64", "data": { "value": v } })
    }
    fn obj(m: serde_json::Value) -> serde_json::Value {
        json!({ "type": "object", "data": { "value": m } })
    }
    fn arr(items: Vec<serde_json::Value>) -> serde_json::Value {
        json!({ "type": "array", "data": { "value": items } })
    }

    /// A frame literal: shader + surface render pass drawing `n` vertices.
    fn frame_literal(n: i64) -> serde_json::Value {
        obj(json!({
            "resources": arr(vec![ obj(json!({ "kind": s("shader"), "id": s("sh"), "wgsl": s("//") })) ]),
            "commands": arr(vec![ obj(json!({
                "op": s("renderPass"), "id": s("main"),
                "color_attachments": arr(vec![ obj(json!({ "view": obj(json!({ "kind": s("surface") })) })) ]),
                "commands": arr(vec![ obj(json!({ "cmd": s("draw"), "vertex_count": i(n) })) ])
            })) ])
        }))
    }

    /// App: submit a frame on start; define `onEvent` that submits a *different*
    /// frame (simulating a state change), and `onResize` that submits too.
    fn app_ast() -> String {
        let submit = |n: i64| json!({ "type": "host_call", "data": { "name": "gpu.submit", "args": [ frame_literal(n) ] } });
        json!({
            "type": "program",
            "body": [
                submit(3),
                { "type": "functionDefinition", "data": {
                    "name": "onEvent", "params": ["e"],
                    "body": [ submit(6) ]
                }},
                { "type": "functionDefinition", "data": {
                    "name": "onResize", "params": ["info"],
                    "body": [ submit(3) ]
                }}
            ]
        })
        .to_string()
    }

    #[test]
    fn instance_runs_app_and_rerenders_on_event() {
        let surface = SurfaceInfo::new(800, 600, 1.0);
        let mut app = Elpa::new(HeadlessBackend::default(), surface, &app_ast())
            .expect("app AST compiles");

        // start -> initial frame: shader created, pass recorded, presented.
        app.start();
        assert_eq!(app.renderer().backend().resources_created, 1);
        assert_eq!(app.renderer().backend().render_passes, 1);
        assert!(app.last_stats().presented);
        assert_eq!(app.last_frame().unwrap().commands.len(), 1);

        // An event changes app state -> a different frame -> the changed surface
        // pass re-records (shader is reused from cache: still 1 create).
        app.send_event(&InputEvent::PointerDown { x: 10.0, y: 10.0, button: 0 });
        assert_eq!(app.renderer().backend().resources_created, 1, "shader reused");
        assert_eq!(app.renderer().backend().render_passes, 2, "frame re-recorded on change");
    }

    #[test]
    fn resize_updates_surface_and_notifies_app() {
        let surface = SurfaceInfo::new(800, 600, 1.0);
        let mut app = Elpa::new(HeadlessBackend::default(), surface, &app_ast()).unwrap();
        app.start();

        app.resize(1280, 720, 2.0);
        assert_eq!(app.surface_info().width, 1280);
        assert_eq!(app.surface_info().scale_factor, 2.0);
        // invalidate() forced a re-record even though the frame content matches.
        assert!(app.renderer().backend().render_passes >= 2);
    }

    fn host_call(name: &str, args: Vec<serde_json::Value>) -> serde_json::Value {
        json!({ "type": "host_call", "data": { "name": name, "args": args } })
    }

    /// A render-level definition literal: a buffer resource + draw commands.
    fn shape_def(id: &str, vb: &str) -> serde_json::Value {
        obj(json!({
            "id": s(id),
            "level": s("render"),
            "resources": arr(vec![ obj(json!({
                "kind": s("buffer"), "id": s(vb), "size": i(48), "usage": arr(vec![ s("VERTEX") ])
            })) ]),
            "commands": arr(vec![
                obj(json!({ "cmd": s("setVertexBuffer"), "slot": i(0), "buffer": s(vb) })),
                obj(json!({ "cmd": s("draw"), "vertex_count": i(3) })),
            ])
        }))
    }

    /// A frame literal whose single surface pass references a definition by id.
    fn frame_using(def_id: &str) -> serde_json::Value {
        obj(json!({
            "commands": arr(vec![ obj(json!({
                "op": s("renderPass"), "id": s("main"),
                "color_attachments": arr(vec![ obj(json!({ "view": obj(json!({ "kind": s("surface") })) })) ]),
                "commands": arr(vec![ obj(json!({ "cmd": s("useDefinition"), "definition": s(def_id) })) ])
            })) ])
        }))
    }

    #[test]
    fn define_then_reference_expands_and_renders() {
        // App: register a shape definition, then submit a frame that references
        // it abstractly. The host should expand the reference into the shape's
        // draw commands and create its buffer resource.
        let program = json!({
            "type": "program",
            "body": [
                host_call("gpu.define", vec![ shape_def("tri", "triVB") ]),
                host_call("gpu.submit", vec![ frame_using("tri") ]),
            ]
        })
        .to_string();

        let surface = SurfaceInfo::new(800, 600, 1.0);
        let mut app = Elpa::new(HeadlessBackend::default(), surface, &program).unwrap();
        app.start();

        assert_eq!(app.definitions().len(), 1, "definition registered");
        // The definition's buffer was created and the surface pass recorded.
        assert_eq!(app.renderer().backend().resources_created, 1);
        assert_eq!(app.renderer().backend().render_passes, 1);
        assert!(app.last_stats().presented);

        // The realized (expanded) frame has the shape's two draw commands and no
        // leftover useDefinition reference.
        let frame = app.last_frame().unwrap();
        assert_eq!(frame.resources.len(), 1);
        match &frame.commands[0] {
            protocol::EncoderCommand::RenderPass(rp) => {
                assert_eq!(rp.commands.len(), 2);
                assert!(rp
                    .commands
                    .iter()
                    .all(|c| !matches!(c, protocol::RenderCommand::UseDefinition { .. })));
            }
            _ => panic!("expected render pass"),
        }
    }

    #[test]
    fn undefine_removes_from_store() {
        let program = json!({
            "type": "program",
            "body": [
                host_call("gpu.define", vec![ shape_def("tri", "triVB") ]),
                host_call("gpu.undefine", vec![ s("tri") ]),
            ]
        })
        .to_string();
        let mut app = Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(8, 8, 1.0), &program)
            .unwrap();
        app.start();
        assert!(app.definitions().is_empty(), "definition unregistered");
    }

    #[test]
    fn import_asset_module_registers_definitions_then_app_uses_them() {
        // The external module (a separate Elpian program) only registers a shape.
        let module = json!({
            "type": "program",
            "body": [ host_call("gpu.define", vec![ shape_def("imported", "impVB") ]) ]
        })
        .to_string();

        // The app imports the module by source, then references its shape.
        let program = json!({
            "type": "program",
            "body": [
                host_call("vm.import", vec![ s("assets/shapes.json") ]),
                host_call("gpu.submit", vec![ frame_using("imported") ]),
            ]
        })
        .to_string();

        let mut app = Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(64, 64, 1.0), &program)
            .unwrap();
        app.register_asset("assets/shapes.json", module);
        app.start();

        assert!(app.definitions().contains("imported"), "import populated the store");
        // The imported shape's buffer was created and its draw recorded.
        assert_eq!(app.renderer().backend().resources_created, 1);
        assert_eq!(app.renderer().backend().render_passes, 1);
        let frame = app.last_frame().unwrap();
        match &frame.commands[0] {
            protocol::EncoderCommand::RenderPass(rp) => assert_eq!(rp.commands.len(), 2),
            _ => panic!("expected render pass"),
        }
    }

    #[test]
    fn import_via_network_fetcher() {
        let module = json!({
            "type": "program",
            "body": [ host_call("gpu.define", vec![ shape_def("net", "netVB") ]) ]
        })
        .to_string();

        let program = json!({
            "type": "program",
            "body": [ host_call("vm.import", vec![ s("https://cdn.example/shapes.json") ]) ]
        })
        .to_string();

        let mut app = Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(8, 8, 1.0), &program)
            .unwrap();
        // Stand in for a synchronous network fetch.
        app.set_fetcher(move |source| {
            if source.starts_with("https://") {
                Some(module.clone())
            } else {
                None
            }
        });
        app.start();
        assert!(app.definitions().contains("net"), "fetched module registered its shape");
    }
}
