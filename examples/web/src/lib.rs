//! Elpa web example: draws an Elpa app's wgpu frames to a full-window,
//! DPI-correct HTML canvas, wiring resize and pointer events into the app.
//!
//! Build with `trunk` or `wasm-pack` — see `README.md`. The flow:
//!
//! 1. Create a `<canvas>` sized to the full window × `devicePixelRatio`.
//! 2. Make a wgpu surface *directly from the canvas* (no winit).
//! 3. Assemble an [`Elpa`] instance over the live [`WgpuBackend`] and an app AST.
//! 4. `requestAnimationFrame` drives `elpa.animate`; resize/pointer listeners
//!    drive `elpa.resize` / `elpa.send_event`. The app re-submits frames; Elpa's
//!    cache + partial rendering keep redraws cheap.

use std::cell::RefCell;
use std::rc::Rc;

use elpa::{Elpa, InputEvent, NetProvider, NetRequest, NetResponse, SurfaceInfo, WgpuBackend};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Synchronous binary `fetch` for the browser, used so an Elpa app can download a
/// font by URL (`useFont(url)`) through the host's `NetProvider`. Elpa's host-call
/// model is synchronous, so this uses a blocking `XMLHttpRequest` and the classic
/// `x-user-defined` charset trick to read the raw bytes out of `responseText`
/// (sync XHR can't return an ArrayBuffer). The URL must allow CORS.
struct WebSyncNet;

impl NetProvider for WebSyncNet {
    fn fetch(&mut self, req: &NetRequest) -> Result<NetResponse, String> {
        let bytes = xhr_get_bytes(&req.method, &req.url)?;
        Ok(NetResponse { status: 200, body: String::new(), bytes: Some(bytes) })
    }
}

/// Blocking XHR returning raw bytes (the `x-user-defined` charset trick, since a
/// synchronous XHR can't yield an ArrayBuffer). Shared by the font net provider
/// and the media fetcher. The URL must allow CORS.
fn xhr_get_bytes(method: &str, url: &str) -> Result<Vec<u8>, String> {
    let xhr = web_sys::XmlHttpRequest::new().map_err(|_| "XHR unavailable".to_string())?;
    xhr.open_with_async(method, url, false).map_err(|_| "XHR open failed".to_string())?;
    let _ = xhr.override_mime_type("text/plain; charset=x-user-defined");
    xhr.send().map_err(|_| "XHR send failed (CORS / network?)".to_string())?;
    let text = xhr.response_text().ok().flatten().unwrap_or_default();
    Ok(text.chars().map(|c| (c as u32 & 0xFF) as u8).collect())
}

/// A live app instance with a canvas-backed wgpu surface (`'static`).
type App = Elpa<WgpuBackend<'static>>;

/// The app bytecode embedded in this build, **precompiled to VM bytecode at
/// build time** by the owning crate's `build_bytecode` tool and loaded straight
/// into the VM via `Elpa::new_from_bytecode` (no JS/AST front-end runs in the
/// browser). By default this is the **Material Design 3 gallery**; build with
/// `trunk build --features game3d` (or `--features game3d` on the wasm build) to
/// embed the **Game3D engine demo** instead — a lit, animated 3D scene driven by
/// the object-oriented `elpa-game3d` SDK. Swap the Material const to
/// `demo.bc` / `graphics.bc` for the other Material apps.
/// Build with `trunk build --features liquidglass` (or `--features liquidglass`
/// on the wasm build) to embed the **Liquid Glass UI kit** demo instead — Apple's
/// iOS-26 glass material (a refractable wallpaper + glass chrome rendered in two
/// GPU passes), driven by the object-oriented `elpa-liquidglass` SDK.
#[cfg(feature = "liquidglass")]
const APP_BYTECODE: &[u8] = include_bytes!("../../liquidglass/assets/demo.bc");
#[cfg(all(feature = "game3d", not(feature = "liquidglass")))]
const APP_BYTECODE: &[u8] = include_bytes!("../../game3d/assets/demo.bc");
#[cfg(all(not(feature = "game3d"), not(feature = "liquidglass")))]
const APP_BYTECODE: &[u8] = include_bytes!("../../material/assets/gallery.bc");

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    wasm_bindgen_futures::spawn_local(run());
}

async fn run() {
    let window = web_sys::window().expect("no window");
    let document = window.document().expect("no document");

    // 1. Full-window canvas. Style it to cover the viewport; size its backing
    //    store to physical pixels so rendering is crisp on HiDPI/mobile.
    let canvas: web_sys::HtmlCanvasElement = document
        .create_element("canvas")
        .unwrap()
        .dyn_into()
        .unwrap();
    canvas.set_id("elpa-canvas");
    let style = canvas.style();
    style.set_property("position", "fixed").unwrap();
    style.set_property("inset", "0").unwrap();
    style.set_property("display", "block").unwrap();
    style.set_property("touch-action", "none").unwrap();
    document.body().unwrap().append_child(&canvas).unwrap();

    let (w, h, dpr) = viewport(&window);
    // Size the canvas CSS box to the *exact logical* viewport (in px), not
    // `100vw/100vh`. On mobile the dynamic URL bar makes `100vh` differ from
    // `innerHeight`, which would stretch the backing store relative to the CSS box
    // and misalign pointer hit-testing (clientY/innerHeight) from rendered widget
    // positions. Matching CSS box == logical size keeps taps and drawing aligned.
    set_css_size(&canvas, w, h, dpr);
    canvas.set_width(w);
    canvas.set_height(h);

    // 2. wgpu surface straight from the canvas.
    //
    // Pick the backend with a *real* WebGPU probe. The sync `Instance::new`
    // can only check that `navigator.gpu` exists, so it commits to a
    // WebGPU-only context whenever the property is present — even on browsers
    // that expose it without a working adapter (Chrome on Linux, headless
    // Chrome). In that case `request_adapter` returns nothing and the WebGL
    // fallback (enabled via the crate's `webgl` feature) is never reached.
    // The async helper requests an adapter up front and, when WebGPU can't
    // provide one, drops `BROWSER_WEBGPU` so wgpu uses the WebGL backend.
    let instance = wgpu::util::new_instance_with_webgpu_detection(
        wgpu::InstanceDescriptor::new_without_display_handle_from_env(),
    )
    .await;
    // Build the canvas surface with an explicit (empty) web display handle.
    // The high-level `create_surface(SurfaceTarget::Canvas)` passes *no* display
    // handle, which the WebGPU context tolerates but the WebGL (wgpu-core)
    // backend rejects with `MissingDisplayHandle` — so the moment we fall back
    // to WebGL, canvas surface creation fails. The WebGPU context ignores the
    // display handle, so supplying `RawDisplayHandle::Web` here is correct for
    // both backends. The `&canvas` JsValue must stay alive across this call;
    // it does (the surface copies it internally and `canvas` outlives us here).
    let surface = {
        let value: &wasm_bindgen::JsValue = &canvas;
        let obj = core::ptr::NonNull::from(value).cast();
        let raw_window_handle = wgpu::rwh::WebCanvasWindowHandle::new(obj).into();
        let raw_display_handle =
            wgpu::rwh::RawDisplayHandle::Web(wgpu::rwh::WebDisplayHandle::new());
        unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(raw_display_handle),
                raw_window_handle,
            })
        }
        .expect("create surface from canvas")
    };
    let backend = WgpuBackend::new(&instance, surface, w, h).await;

    // 3. Assemble the Elpa instance over the live backend + the UI-kit app.
    //
    // The app is the **Material Design 3 widget gallery**, written in
    // **JavaScript**: a Flutter-style widget SDK linked ahead of an app
    // (`GALLERY_JS`) that composes a widget tree and calls `runApp`. Its
    // JS→AST→bytecode compile happens at **build/deploy time** (the
    // `elpa-material` `build_bytecode` tool, run in CI before the Pages build),
    // and the resulting bytecode is embedded here and loaded straight into the
    // VM with `new_from_bytecode` — no front-end runs in the browser. The SDK's
    // component runtime owns layout, animation, and `gpu.submit`, and reads the
    // surface's actual color format from `gpu.surfaceInfo`, so its pipeline
    // target matches the surface exactly (the browser surface may be `*-srgb`,
    // which wgpu requires the pipeline to match) without any source patching.
    let surface_info = SurfaceInfo::new(w, h, dpr);
    let mut app = Elpa::new_from_bytecode(backend, surface_info, APP_BYTECODE.to_vec())
        .expect("app bytecode loads");
    // Grant network + a synchronous binary fetcher so the app can download a font
    // by URL at runtime (the gallery's `f` key calls `useFont(...)`).
    {
        let mut toggles = app.env().toggles();
        toggles.network = true;
        app.env_mut().set_toggles(toggles);
        app.env_mut().set_net(Box::new(WebSyncNet));
        // Media fetcher for images / animated GIFs. The browser has no host
        // threads, so on wasm the media engine decodes inline at request time
        // (this blocking XHR does the download); the guest still polls and shows a
        // placeholder until the pixels arrive, so the UI stays responsive.
        app.env_mut().set_media_fetcher(Box::new(|url: &str| xhr_get_bytes("GET", url)));
    }
    app.start(); // run the SDK + app, paint the first frame

    let app = Rc::new(RefCell::new(app));

    install_resize(&window, &canvas, app.clone());
    install_pointer(&canvas, app.clone());
    install_wheel(&canvas, app.clone());
    install_keyboard(&window, app.clone());
    start_raf(window, app);
}

/// Set the canvas CSS box to the logical size (physical / dpr) in explicit
/// pixels, so the drawn backing store and pointer coordinates stay 1:1.
fn set_css_size(canvas: &web_sys::HtmlCanvasElement, w: u32, h: u32, dpr: f64) {
    let style = canvas.style();
    style
        .set_property("width", &format!("{}px", (w as f64 / dpr)))
        .unwrap();
    style
        .set_property("height", &format!("{}px", (h as f64 / dpr)))
        .unwrap();
}

/// Current viewport in (physical_w, physical_h, scale_factor).
fn viewport(window: &web_sys::Window) -> (u32, u32, f64) {
    let dpr = window.device_pixel_ratio().max(1.0);
    let cw = window.inner_width().unwrap().as_f64().unwrap_or(1.0);
    let ch = window.inner_height().unwrap().as_f64().unwrap_or(1.0);
    (((cw * dpr) as u32).max(1), ((ch * dpr) as u32).max(1), dpr)
}

/// Reconfigure the GPU surface and notify the app on every window resize so the
/// canvas always fills the screen at the right DPI (desktop, tablet, phone).
fn install_resize(
    window: &web_sys::Window,
    canvas: &web_sys::HtmlCanvasElement,
    app: Rc<RefCell<App>>,
) {
    let win = window.clone();
    let canvas = canvas.clone();
    let cb = Closure::<dyn FnMut()>::new(move || {
        let (w, h, dpr) = viewport(&win);
        set_css_size(&canvas, w, h, dpr);
        canvas.set_width(w);
        canvas.set_height(h);
        let mut app = app.borrow_mut();
        app.renderer_mut().backend_mut().resize(w, h); // reconfigure swapchain
        app.resize(w, h, dpr); // update SurfaceInfo + invoke app `onResize`
    });
    window
        .add_event_listener_with_callback("resize", cb.as_ref().unchecked_ref())
        .unwrap();
    cb.forget();
}

/// Forward pointer events as normalized Elpa input events.
fn install_pointer(canvas: &web_sys::HtmlCanvasElement, app: Rc<RefCell<App>>) {
    let listen = |name: &str,
                  make: Rc<dyn Fn(&web_sys::PointerEvent) -> InputEvent>,
                  app: Rc<RefCell<App>>,
                  canvas: &web_sys::HtmlCanvasElement| {
        let cb =
            Closure::<dyn FnMut(web_sys::PointerEvent)>::new(move |ev: web_sys::PointerEvent| {
                app.borrow_mut().send_event(&make(&ev));
            });
        canvas
            .add_event_listener_with_callback(name, cb.as_ref().unchecked_ref())
            .unwrap();
        cb.forget();
    };

    listen(
        "pointerdown",
        Rc::new(|e| InputEvent::PointerDown {
            x: e.client_x() as f64,
            y: e.client_y() as f64,
            button: e.button() as u8,
        }),
        app.clone(),
        canvas,
    );
    listen(
        "pointermove",
        Rc::new(|e| InputEvent::PointerMove {
            x: e.client_x() as f64,
            y: e.client_y() as f64,
        }),
        app.clone(),
        canvas,
    );
    listen(
        "pointerup",
        Rc::new(|e| InputEvent::PointerUp {
            x: e.client_x() as f64,
            y: e.client_y() as f64,
            button: e.button() as u8,
        }),
        app,
        canvas,
    );
}

/// Forward mouse-wheel events (the demo uses them to nudge the slider). The
/// listener is non-passive so it can `preventDefault` and stop the page from
/// scrolling under the full-window canvas.
fn install_wheel(canvas: &web_sys::HtmlCanvasElement, app: Rc<RefCell<App>>) {
    let cb = Closure::<dyn FnMut(web_sys::WheelEvent)>::new(move |e: web_sys::WheelEvent| {
        e.prevent_default();
        app.borrow_mut().send_event(&InputEvent::Wheel {
            x: e.client_x() as f64,
            y: e.client_y() as f64,
            delta_y: e.delta_y(),
        });
    });
    let opts = web_sys::AddEventListenerOptions::new();
    opts.set_passive(false);
    canvas
        .add_event_listener_with_callback_and_add_event_listener_options(
            "wheel",
            cb.as_ref().unchecked_ref(),
            &opts,
        )
        .unwrap();
    cb.forget();
}

/// Forward keyboard events on the window (arrows nudge the slider; `d` toggles
/// dark mode, space toggles the switch, `r` resets — see the demo's `onEvent`).
fn install_keyboard(window: &web_sys::Window, app: Rc<RefCell<App>>) {
    let down_app = app.clone();
    let down =
        Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
            down_app
                .borrow_mut()
                .send_event(&InputEvent::KeyDown { key: e.key() });
        });
    window
        .add_event_listener_with_callback("keydown", down.as_ref().unchecked_ref())
        .unwrap();
    down.forget();

    let up = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
        app.borrow_mut()
            .send_event(&InputEvent::KeyUp { key: e.key() });
    });
    window
        .add_event_listener_with_callback("keyup", up.as_ref().unchecked_ref())
        .unwrap();
    up.forget();
}

/// Drive continuous animation via `requestAnimationFrame`. When the page URL
/// carries `?perf=1`, each batch of 60 frames is summarised to `console.log`
/// (mean / p50 / p95 / max ms per `animate()` call) for the headless perf
/// scripts in `scripts/web-frame-perf.js`; otherwise the loop is the same as
/// before, with no measurement overhead at all.
fn start_raf(window: web_sys::Window, app: Rc<RefCell<App>>) {
    let f: Rc<RefCell<Option<Closure<dyn FnMut(f64)>>>> = Rc::new(RefCell::new(None));
    let g = f.clone();
    let mut last = 0.0f64;
    let win = window.clone();

    let perf_enabled = window
        .location()
        .search()
        .ok()
        .map(|s| s.contains("perf=1"))
        .unwrap_or(false);
    let perf = if perf_enabled { window.performance() } else { None };
    let mut samples: Vec<f64> = if perf_enabled {
        Vec::with_capacity(60)
    } else {
        Vec::new()
    };

    *g.borrow_mut() = Some(Closure::new(move |ts: f64| {
        let dt = if last == 0.0 { 16.0 } else { ts - last };
        last = ts;
        if let Some(p) = perf.as_ref() {
            let t0 = p.now();
            app.borrow_mut().animate(dt);
            let t1 = p.now();
            samples.push(t1 - t0);
            if samples.len() >= 60 {
                samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let n = samples.len();
                let mean = samples.iter().sum::<f64>() / n as f64;
                let p50 = samples[n / 2];
                let p95 = samples[(n * 95) / 100];
                let max = samples[n - 1];
                web_sys::console::log_1(
                    &format!(
                        "[elpa-frame] n={n} mean={mean:.1}ms p50={p50:.1}ms p95={p95:.1}ms max={max:.1}ms"
                    )
                    .into(),
                );
                samples.clear();
            }
        } else {
            app.borrow_mut().animate(dt);
        }
        win.request_animation_frame(f.borrow().as_ref().unwrap().as_ref().unchecked_ref())
            .unwrap();
    }));
    window
        .request_animation_frame(g.borrow().as_ref().unwrap().as_ref().unchecked_ref())
        .unwrap();
}
