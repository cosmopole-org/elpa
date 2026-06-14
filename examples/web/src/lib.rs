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

use elpa::{Elpa, InputEvent, SurfaceInfo, WgpuBackend};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// A live app instance with a canvas-backed wgpu surface (`'static`).
type App = Elpa<WgpuBackend<'static>>;

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
    let format_token = format_token(backend.surface_format());

    // 3. Assemble the Elpa instance over the live backend + the UI-kit demo app.
    //
    // The app is the **Material Design 3 UI-kit example**, which is itself
    // **JavaScript**: `DEMO_JS` imports the kit module and lays out interactive
    // widgets (buttons, FAB, switch, checkbox, radios, slider, chips, progress,
    // cards), wiring pointer / wheel / keyboard events to widget state. Elpa
    // compiles the JS to its VM with `new_from_js` — no off-VM toolchain.
    // Register the importable kit module (also JS) as the asset the demo imports —
    // with the pipeline's color target retargeted to this surface's actual format
    // (the kit names `bgra8unorm`; the browser surface may be `*-srgb`, and wgpu
    // requires the pipeline target to match the surface exactly).
    let module =
        elpa_material::MODULE_JS.replace("\"bgra8unorm\"", &format!("\"{format_token}\""));
    let surface_info = SurfaceInfo::new(w, h, dpr);
    let mut app =
        Elpa::new_from_js(backend, surface_info, elpa_material::DEMO_JS).expect("app JS compiles");
    app.register_asset(elpa_material::MODULE_SOURCE, module);
    app.start(); // import the kit module + first frame

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

/// Map a wgpu surface format to the protocol's format token so the app's
/// pipeline target matches the surface.
fn format_token(fmt: wgpu::TextureFormat) -> String {
    use wgpu::TextureFormat as F;
    match fmt {
        F::Bgra8Unorm => "bgra8unorm",
        F::Bgra8UnormSrgb => "bgra8unorm-srgb",
        F::Rgba8Unorm => "rgba8unorm",
        F::Rgba8UnormSrgb => "rgba8unorm-srgb",
        _ => "bgra8unorm",
    }
    .to_string()
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

/// Drive continuous animation via `requestAnimationFrame`.
fn start_raf(window: web_sys::Window, app: Rc<RefCell<App>>) {
    let f: Rc<RefCell<Option<Closure<dyn FnMut(f64)>>>> = Rc::new(RefCell::new(None));
    let g = f.clone();
    let mut last = 0.0f64;
    let win = window.clone();

    *g.borrow_mut() = Some(Closure::new(move |ts: f64| {
        let dt = if last == 0.0 { 16.0 } else { ts - last };
        last = ts;
        app.borrow_mut().animate(dt);
        win.request_animation_frame(f.borrow().as_ref().unwrap().as_ref().unchecked_ref())
            .unwrap();
    }));
    window
        .request_animation_frame(g.borrow().as_ref().unwrap().as_ref().unchecked_ref())
        .unwrap();
}
