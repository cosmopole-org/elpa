//! Cross-platform Elpa example: **desktop (Windows/macOS/Linux) and Android**.
//!
//! It draws the same triangle-over-animated-background as the web example, but
//! to a native [`winit`] window via the live [`WgpuBackend`]. The window and GPU
//! surface are created lazily in [`ApplicationHandler::resumed`] and dropped in
//! [`ApplicationHandler::suspended`]:
//!
//! * On **Android** this is mandatory — the native surface only exists between
//!   `resumed`/`suspended`, and creating a surface before `resumed` panics.
//! * On **desktop** the first `resumed` fires immediately, so the same code path
//!   works unchanged.
//!
//! Desktop builds run through [`run`] from `main.rs`; Android builds enter through
//! the exported `android_main` below (built as a `cdylib` by `cargo apk`/
//! `cargo ndk`).

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use elpa::{Elpa, InputEvent, SurfaceInfo, WgpuBackend};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

mod app_ast;

/// A live app instance over a window-backed wgpu surface (`'static`, since the
/// surface is built from an `Arc<Window>` we keep alive alongside it).
type App = Elpa<WgpuBackend<'static>>;

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

/// Everything that exists only while we hold a surface. On Android this is
/// recreated on each `resumed` and torn down on each `suspended`.
struct State {
    window: Arc<Window>,
    app: Rc<RefCell<App>>,
}

#[derive(Default)]
struct ElpaApp {
    state: Option<State>,
}

impl ElpaApp {
    /// Create the window, the wgpu surface from it, and the Elpa instance.
    fn init(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(Window::default_attributes().with_title("Elpa — triangle"))
                .expect("create window"),
        );
        let size = window.inner_size();
        let (w, h) = (size.width.max(1), size.height.max(1));
        let scale = window.scale_factor();

        // wgpu surface straight from the window. An `Arc<Window>` yields a
        // `Surface<'static>`, and the window carries the display handle the
        // native backends (DX12/Vulkan/GL) need, so the bare instance is fine.
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let surface = instance
            .create_surface(window.clone())
            .expect("create surface from window");
        let backend = pollster::block_on(WgpuBackend::new(&instance, surface, w, h));

        let ast = app_ast::build(&format_token(backend.surface_format()));
        let surface_info = SurfaceInfo::new(w, h, scale);
        let mut app = Elpa::new(backend, surface_info, &ast).expect("app AST compiles");
        app.start(); // run top-level program (init + first frame)

        self.state = Some(State {
            window,
            app: Rc::new(RefCell::new(app)),
        });
    }
}

impl ApplicationHandler for ElpaApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(ControlFlow::Poll);
        if self.state.is_none() {
            self.init(event_loop);
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        // Release the surface/window: on Android the native surface is gone
        // after suspend; we rebuild it on the next `resumed`.
        self.state = None;
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = self.state.as_ref() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                let (w, h) = (size.width.max(1), size.height.max(1));
                let mut app = state.app.borrow_mut();
                app.renderer_mut().backend_mut().resize(w, h); // reconfigure swapchain
                app.resize(w, h, state.window.scale_factor()); // SurfaceInfo + app onResize
            }
            // A click or touch jumps the animation forward (mirrors the web example).
            WindowEvent::MouseInput { state: ElementState::Pressed, .. }
            | WindowEvent::Touch(_) => {
                state
                    .app
                    .borrow_mut()
                    .send_event(&InputEvent::PointerDown { x: 0.0, y: 0.0, button: 0 });
            }
            WindowEvent::RedrawRequested => {
                // Drive animation and present a frame.
                state.app.borrow_mut().animate(16.0);
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(state) = self.state.as_ref() {
            state.window.request_redraw();
        }
    }
}

/// Run the winit event loop with the Elpa application handler. Shared by the
/// desktop `main` and the Android `android_main` entry points.
pub fn run(event_loop: EventLoop<()>) {
    let mut app = ElpaApp::default();
    event_loop.run_app(&mut app).expect("event loop failed");
}

/// Android entry point. `cargo apk`/`cargo ndk` build this crate as a `cdylib`;
/// the `android-activity` glue (pulled in via winit's `android-native-activity`
/// feature) calls this `android_main` from the activity's native `onCreate`.
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(android_app: winit::platform::android::activity::AndroidApp) {
    use winit::platform::android::EventLoopBuilderExtAndroid;

    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info),
    );

    let event_loop = EventLoop::builder()
        .with_android_app(android_app)
        .build()
        .expect("build android event loop");
    run(event_loop);
}
