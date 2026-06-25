//! The flutter_rust_bridge surface Dart calls.
//!
//! Design: an Elpa engine is **not** passed across the FFI boundary as an opaque
//! pointer. Instead each engine lives in a process-global registry keyed by a
//! `u64` handle (the same shape as the VM's own `machine_id` registry), and Dart
//! holds only that handle. Every call therefore moves just a `u64`, a few
//! strings, and the returned message list — there is no `Send`/lifetime juggling
//! and message payloads are moved, never copied through an opaque wrapper.
//!
//! All functions are `#[frb(sync)]`: the engine drives the VM synchronously and
//! returns the messages emitted during the turn, so Dart gets the UI stream as a
//! direct return value with no executor hop. Heavy work (compiling a large app)
//! is the only place a host might prefer the async default; `create_*` is left
//! sync for simplicity and wrapped on the Dart side if needed.

use std::sync::Mutex;

use flutter_rust_bridge::frb;
use once_cell::sync::Lazy;

use crate::engine::{channel, ElpaEngine, OutMessage, Pointer};

/// One-time process initialization, run lazily from the (synchronous) engine
/// entry points rather than through a `#[frb(init)]` hook.
///
/// Why not `#[frb(init)]`: flutter_rust_bridge dispatches an `#[frb(init)]`
/// function as a *normal* (non-sync) task, which on its `executeRustInitializers`
/// path spins up the bridge's `WorkerPool`. On the web that pool tries to
/// `postMessage` the wasm `Memory` to a worker, and for this app's
/// **single-threaded** wasm (built without `+atomics`, so the memory is not
/// shared) that fails with `DataCloneError: #<Memory> could not be cloned` and
/// panics during startup — leaving the demo a blank screen. This whole app uses
/// only `#[frb(sync)]` calls, so no worker pool is ever needed; initializing from
/// a sync entry point keeps the pool from ever being constructed.
fn ensure_init() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // On web, make a Rust panic print its message + location to the browser
        // console rather than aborting as an opaque `RuntimeError: unreachable`.
        #[cfg(target_arch = "wasm32")]
        console_error_panic_hook::set_once();
        // Otherwise nothing global to initialize; the VM registry is lazy.
    });
}

/// A message crossing the pipe, as Dart sees it. `payload` is raw JSON text the
/// Dart side decodes once.
pub struct FfiMessage {
    pub channel: String,
    pub payload: String,
}

impl From<OutMessage> for FfiMessage {
    fn from(m: OutMessage) -> Self {
        FfiMessage { channel: m.channel, payload: m.payload }
    }
}

fn into_ffi(msgs: Vec<OutMessage>) -> Vec<FfiMessage> {
    msgs.into_iter().map(FfiMessage::from).collect()
}

/// Pointer phase mirrored from [`Pointer`] for the Dart enum.
pub enum FfiPointer {
    Down,
    Move,
    Up,
}

impl From<FfiPointer> for Pointer {
    fn from(p: FfiPointer) -> Self {
        match p {
            FfiPointer::Down => Pointer::Down,
            FfiPointer::Move => Pointer::Move,
            FfiPointer::Up => Pointer::Up,
        }
    }
}

/// A `Send` wrapper for an engine held in the global registry.
///
/// SAFETY: an [`ElpaEngine`] is not auto-`Send` because [`elpa::Elpa`] holds
/// host-provided trait objects (the fabricated fs/net, optional closures) without
/// `Send` bounds. The registry serializes *all* access through [`ENGINES`]'s
/// mutex, and an engine is only ever driven from the isolate thread that owns it
/// — it is never shared or mutated concurrently. This is the same invariant, and
/// the same `unsafe impl Send`, the underlying `elpian_vm::VM` relies on for its
/// own process-global registry.
struct SendEngine(ElpaEngine);
unsafe impl Send for SendEngine {}

/// The process-global engine registry. A `Mutex` (not `RwLock`) because every
/// operation drives the VM (a `&mut` turn), so there are no read-only paths to
/// parallelize. Contention is a non-issue: a Flutter app drives one engine from
/// the UI isolate.
static ENGINES: Lazy<Mutex<std::collections::HashMap<u64, SendEngine>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));
static NEXT_HANDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn insert(engine: ElpaEngine) -> u64 {
    let handle = NEXT_HANDLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ENGINES.lock().unwrap().insert(handle, SendEngine(engine));
    handle
}

/// Run `f` against the engine for `handle`, returning its emitted messages (or an
/// empty list if the handle is unknown — a disposed/never-created engine).
fn with<R>(handle: u64, f: impl FnOnce(&mut ElpaEngine) -> R) -> Option<R> {
    ENGINES.lock().unwrap().get_mut(&handle).map(|e| f(&mut e.0))
}

// ---- Reserved channel names (so Dart need not hard-code strings) -------------

#[frb(sync)]
pub fn channel_render() -> String {
    channel::RENDER.to_string()
}
#[frb(sync)]
pub fn channel_patch() -> String {
    channel::PATCH.to_string()
}
#[frb(sync)]
pub fn channel_invalidate() -> String {
    channel::INVALIDATE.to_string()
}
#[frb(sync)]
pub fn channel_define() -> String {
    channel::DEFINE.to_string()
}
#[frb(sync)]
pub fn channel_event() -> String {
    channel::EVENT.to_string()
}

// ---- Lifecycle ---------------------------------------------------------------

/// Create an engine from JavaScript source. Returns a handle, or `None` if the
/// source is outside the supported JS subset.
#[frb(sync)]
pub fn create_from_js(js_source: String, width: u32, height: u32, scale: f64) -> Option<u64> {
    ensure_init();
    ElpaEngine::from_js(&js_source, width, height, scale).map(insert)
}

/// Create an engine from Elpian AST JSON.
#[frb(sync)]
pub fn create_from_ast(ast_json: String, width: u32, height: u32, scale: f64) -> Option<u64> {
    ensure_init();
    ElpaEngine::from_ast(&ast_json, width, height, scale).map(insert)
}

/// Create an engine from prebuilt VM bytecode (the shipped/deployed path).
#[frb(sync)]
pub fn create_from_bytecode(bytecode: Vec<u8>, width: u32, height: u32, scale: f64) -> Option<u64> {
    ensure_init();
    ElpaEngine::from_bytecode(bytecode, width, height, scale).map(insert)
}

/// Run the app's top-level program; returns the initial render/messages.
#[frb(sync)]
pub fn start(handle: u64) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.start())).unwrap_or_default()
}

/// Dispose of an engine and free its VM. Returns whether one was present.
#[frb(sync)]
pub fn dispose(handle: u64) -> bool {
    ENGINES.lock().unwrap().remove(&handle).is_some()
}

// ---- Native GPU surface (the zero-copy 3D path) ------------------------------

/// Register the platform render surface for engine `handle` and upgrade it from
/// the headless backend to a live wgpu backend, so the app's `Native3DView` shows
/// real GPU pixels. Returns whether a GPU backend is now installed.
///
/// One stable entry point across platforms (so codegen yields one Dart binding);
/// it dispatches on the build target:
///
/// * **Web** — `canvas_id` is the id of the `<canvas>` Flutter hosts via
///   `HtmlElementView`. Building the wgpu surface needs the browser's async
///   adapter/device handshake, which only makes progress on the JS **event loop**.
///   Awaiting it *inside* this call deadlocks on the single-threaded web build:
///   flutter_rust_bridge runs the call's future on the sync-FFI path, which never
///   yields back to the loop, so the adapter promise never resolves and the 3D
///   card stays blank forever (no error — it simply hangs at the first `.await`).
///   So we **don't** await here: we `spawn_local` the init onto the event loop and
///   return immediately; the live backend is swapped into the engine once it's
///   ready, and the next animation frame paints the scene. Returns `true` to mean
///   "kicked off" (the result is advisory; the app keeps running either way).
/// * **Native (desktop/mobile)** — `raw_handle` is the OS handle to a shared
///   buffer a native texture-registry plugin already registered with Flutter (see
///   `render::SharedTextureHandle`); we import it zero-copy. `row_stride` carries
///   the buffer's byte stride when padded (`0` = tightly packed). Native has real
///   threads, so building the backend synchronously here is fine.
///
/// Kept `async` (not `#[frb(sync)]`) only to preserve one binding signature across
/// platforms; the web arm no longer awaits, and the native arm is synchronous.
#[allow(unused_variables)]
pub async fn register_surface(
    handle: u64,
    canvas_id: String,
    raw_handle: i64,
    row_stride: u32,
    width: u32,
    height: u32,
) -> bool {
    #[cfg(all(feature = "gpu", target_arch = "wasm32"))]
    {
        use wasm_bindgen::JsCast;
        let canvas = match web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id(&canvas_id))
            .and_then(|el| el.dyn_into::<web_sys::HtmlCanvasElement>().ok())
        {
            Some(c) => c,
            None => {
                web_sys::console::error_1(
                    &format!("elpa: native surface canvas '{canvas_id}' not found in DOM").into(),
                );
                return false;
            }
        };
        // Drive the wgpu init on the browser event loop (see the doc comment): the
        // adapter/device promise can only resolve there, so awaiting it inside this
        // FRB call would hang the single-threaded web build. spawn_local returns at
        // once; the backend installs into the engine registry when it's ready.
        wasm_bindgen_futures::spawn_local(async move {
            match crate::render::build_web_backend(canvas, width, height).await {
                Some(backend) => {
                    let live = with(handle, |e| {
                        e.install_backend(backend);
                        e.has_gpu_backend()
                    })
                    .unwrap_or(false);
                    web_sys::console::log_1(
                        &format!("elpa: wgpu surface registered (live={live}, {width}x{height})")
                            .into(),
                    );
                }
                None => web_sys::console::error_1(
                    &"elpa: wgpu backend init failed (no GPU adapter/surface); 3D card stays a placeholder"
                        .into(),
                ),
            }
        });
        true
    }
    #[cfg(all(feature = "gpu", not(target_arch = "wasm32")))]
    {
        let sh = crate::render::SharedTextureHandle { raw: raw_handle, row_stride };
        match crate::render::build_native_backend(sh, width, height) {
            Some(backend) => with(handle, |e| {
                e.install_backend(backend);
                e.has_gpu_backend()
            })
            .unwrap_or(false),
            None => false,
        }
    }
    #[cfg(not(feature = "gpu"))]
    {
        false
    }
}

/// Whether engine `handle` currently has a live wgpu backend installed.
#[frb(sync)]
pub fn surface_is_live(handle: u64) -> bool {
    with(handle, |e| e.has_gpu_backend()).unwrap_or(false)
}

// ---- Driving the app ---------------------------------------------------------

/// Forward a pointer event (logical coordinates); returns emitted UI messages.
#[frb(sync)]
pub fn pointer(handle: u64, phase: FfiPointer, x: f64, y: f64, button: i32) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.pointer(phase.into(), x, y, button as i64))).unwrap_or_default()
}

/// Forward a scroll/wheel event.
#[frb(sync)]
pub fn wheel(handle: u64, x: f64, y: f64, delta_y: f64) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.wheel(x, y, delta_y))).unwrap_or_default()
}

/// Forward a key event.
#[frb(sync)]
pub fn key(handle: u64, down: bool, key: String) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.key(down, key))).unwrap_or_default()
}

/// Advance one animation tick (`onFrame(dtMs)`); returns the next frame's UI.
#[frb(sync)]
pub fn frame(handle: u64, dt_ms: f64) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.frame(dt_ms))).unwrap_or_default()
}

/// Report a surface resize (physical pixels + device pixel ratio).
#[frb(sync)]
pub fn resize(handle: u64, width: u32, height: u32, scale: f64) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.resize(width, height, scale))).unwrap_or_default()
}

/// Report updated safe-area insets (physical pixels).
#[frb(sync)]
pub fn safe_area(handle: u64, top: f64, right: f64, bottom: f64, left: f64) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.safe_area(top, right, bottom, left))).unwrap_or_default()
}

// ---- The messaging pipe (host -> guest) --------------------------------------

/// Deliver a custom message into the app on `channel` (the generic inbound leg).
/// `payload_json` is raw JSON text. Returns whatever the app emits in response.
#[frb(sync)]
pub fn post(handle: u64, channel: String, payload_json: String) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.post(&channel, &payload_json))).unwrap_or_default()
}

/// Convenience: deliver a Flutter UI/gesture event on the reserved event channel.
#[frb(sync)]
pub fn post_event(handle: u64, payload_json: String) -> Vec<FfiMessage> {
    with(handle, |e| into_ffi(e.post_event(&payload_json))).unwrap_or_default()
}

/// Drain diagnostic log lines emitted by the app.
#[frb(sync)]
pub fn take_log(handle: u64) -> Vec<String> {
    with(handle, |e| e.take_log()).unwrap_or_default()
}
