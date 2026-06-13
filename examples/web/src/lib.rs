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

mod app_ast;

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
    style.set_property("width", "100vw").unwrap();
    style.set_property("height", "100vh").unwrap();
    style.set_property("display", "block").unwrap();
    style.set_property("touch-action", "none").unwrap();
    document.body().unwrap().append_child(&canvas).unwrap();

    let (w, h, dpr) = viewport(&window);
    canvas.set_width(w);
    canvas.set_height(h);

    // 2. wgpu surface straight from the canvas.
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .expect("create surface from canvas");
    let backend = WgpuBackend::new(&instance, surface, w, h).await;
    let format_token = format_token(backend.surface_format());

    // 3. Assemble the Elpa instance over the live backend + the app AST.
    let ast = app_ast::build(&format_token);
    let surface_info = SurfaceInfo::new(w, h, dpr);
    let mut app = Elpa::new(backend, surface_info, &ast).expect("app AST compiles");
    app.start(); // run top-level program (init + first frame)

    let app = Rc::new(RefCell::new(app));

    install_resize(&window, &canvas, app.clone());
    install_pointer(&canvas, app.clone());
    start_raf(window, app);
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
fn install_resize(window: &web_sys::Window, canvas: &web_sys::HtmlCanvasElement, app: Rc<RefCell<App>>) {
    let win = window.clone();
    let canvas = canvas.clone();
    let cb = Closure::<dyn FnMut()>::new(move || {
        let (w, h, dpr) = viewport(&win);
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
    let listen = |name: &str, make: Rc<dyn Fn(&web_sys::PointerEvent) -> InputEvent>, app: Rc<RefCell<App>>, canvas: &web_sys::HtmlCanvasElement| {
        let cb = Closure::<dyn FnMut(web_sys::PointerEvent)>::new(move |ev: web_sys::PointerEvent| {
            app.borrow_mut().send_event(&make(&ev));
        });
        canvas
            .add_event_listener_with_callback(name, cb.as_ref().unchecked_ref())
            .unwrap();
        cb.forget();
    };

    listen(
        "pointerdown",
        Rc::new(|e| InputEvent::PointerDown { x: e.client_x() as f64, y: e.client_y() as f64, button: e.button() as u8 }),
        app.clone(),
        canvas,
    );
    listen(
        "pointermove",
        Rc::new(|e| InputEvent::PointerMove { x: e.client_x() as f64, y: e.client_y() as f64 }),
        app.clone(),
        canvas,
    );
    listen(
        "pointerup",
        Rc::new(|e| InputEvent::PointerUp { x: e.client_x() as f64, y: e.client_y() as f64, button: e.button() as u8 }),
        app,
        canvas,
    );
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
