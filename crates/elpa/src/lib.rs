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
pub use elpa_protocol::{self as protocol, Frame};
pub use elpa_renderer::{FrameStats, GpuBackend, Renderer};

#[cfg(feature = "wgpu")]
pub use elpa_renderer::wgpu_backend::WgpuBackend;

use std::sync::atomic::{AtomicU64, Ordering};

use elpa_runtime::{frame_from_submit, reply_json, reply_null, Runtime, Start};

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

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
}

impl<B: GpuBackend> Elpa<B> {
    /// Assemble an instance from a GPU backend, the initial surface geometry, and
    /// an Elpian AST JSON program. Returns `None` if the AST fails to compile.
    pub fn new(backend: B, surface: SurfaceInfo, ast_json: &str) -> Option<Self> {
        let id = format!("elpa-{}", INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed));
        let runtime = Runtime::from_ast(id, ast_json)?;
        Some(Self {
            runtime,
            renderer: Renderer::new(backend),
            surface,
            last_frame: None,
            last_stats: FrameStats::default(),
            log: Vec::new(),
        })
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

    /// Pump the VM for one turn, routing host calls. `gpu.submit` frames are fed
    /// straight to the renderer (where caching + partial rendering happen);
    /// `gpu.surfaceInfo` is answered from live state.
    fn drive(&mut self, start: Start) {
        // Disjoint borrows of the instance's fields for the dispatch closure.
        let Elpa { runtime, renderer, surface, last_frame, last_stats, log } = self;
        runtime.pump(start, |hc| match hc.api_name.as_str() {
            "gpu.submit" => {
                if let Some(frame) = frame_from_submit(hc) {
                    *last_stats = renderer.render(&frame);
                    *last_frame = Some(frame);
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
        });
    }
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
}
