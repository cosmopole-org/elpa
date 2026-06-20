//! Cross-platform Elpa example: **desktop (Windows/macOS/Linux) and Android**.
//!
//! It runs the Material Design 3 SDK demo to a native [`winit`] window via
//! the live [`WgpuBackend`]. The window and GPU
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
use std::time::{Duration, Instant};

use elpa::{Elpa, Insets, InputEvent, NetProvider, NetRequest, NetResponse, SurfaceInfo, WgpuBackend};

/// Blocking HTTP for desktop, so an Elpa app can download a font by URL
/// (`useFont(url)`) through the host's `NetProvider` — Elpa's host-call model is
/// synchronous, and `ureq` is a blocking client, so this is a direct fit.
struct NativeNet;

impl NetProvider for NativeNet {
    fn fetch(&mut self, req: &NetRequest) -> Result<NetResponse, String> {
        let mut resp = ureq::get(&req.url).call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let bytes = resp
            .body_mut()
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok(NetResponse { status, body: String::new(), bytes: Some(bytes) })
    }
}
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

/// A live app instance over a window-backed wgpu surface (`'static`, since the
/// surface is built from an `Arc<Window>` we keep alive alongside it).
type App = Elpa<WgpuBackend<'static>>;

const TARGET_FRAME_TIME: Duration = Duration::from_nanos(16_666_667);
const MAX_ANIMATION_DT_MS: f64 = 100.0;

/// The `AndroidApp` handle, stashed at `android_main` so the render loop can
/// query the live content rectangle — and thus the system-bar insets — on every
/// resize. winit hands it to `android_main` but does not otherwise surface it to
/// the application handler.
#[cfg(target_os = "android")]
static ANDROID_APP: std::sync::OnceLock<winit::platform::android::activity::AndroidApp> =
    std::sync::OnceLock::new();

/// The platform safe-area insets (status bar / navigation bar / display cutout),
/// in physical pixels, for a window of physical size `w`×`h`.
///
/// On Android the wgpu surface covers the whole window edge-to-edge, while the
/// `android-activity` glue reports the *content rectangle* — the region the
/// system leaves for app content between its bars. Their difference is exactly
/// the space reserved for system UI, which is what the app must keep its chrome
/// clear of. Desktop has no system insets, so this is always zero there.
#[allow(unused_variables)]
fn safe_area_insets(w: u32, h: u32) -> Insets {
    #[cfg(target_os = "android")]
    {
        if let Some(app) = ANDROID_APP.get() {
            let r = app.content_rect();
            // An empty / not-yet-reported rect means the system hasn't told us
            // where the content goes; treat it as no insets rather than reserving
            // the entire window.
            if r.right > r.left && r.bottom > r.top {
                let top = r.top.max(0) as f64;
                let left = r.left.max(0) as f64;
                let right = (w as i32 - r.right).max(0) as f64;
                let bottom = (h as i32 - r.bottom).max(0) as f64;
                return Insets::new(top, right, bottom, left);
            }
        }
    }
    Insets::ZERO
}

/// The app bytecode embedded in this build, **precompiled to VM bytecode at
/// build time** by the owning crate's `build_bytecode` tool and loaded straight
/// into the VM via `Elpa::new_from_bytecode` (no JS/AST front-end runs at
/// startup). The SDK reads the live surface color format from `gpu.surfaceInfo`
/// and builds its pipeline target to match, so one bytecode runs on any surface.
/// By default this is the **Material Design 3 gallery**; build with
/// `--features game3d` to embed the **Game3D engine demo** instead — a lit,
/// animated 3D scene driven by the object-oriented `elpa-game3d` SDK. (Swap the
/// Material const to `demo.bc` / `graphics.bc` for the other Material apps.)
/// Run with `cargo run --features liquidglass` to embed the **Liquid Glass UI
/// kit** demo instead — Apple's iOS-26 glass material (a refractable wallpaper +
/// glass chrome rendered in two GPU passes) from the `elpa-liquidglass` SDK. Run
/// with `cargo run --features calculator` to embed the **Liquid Glass
/// calculator** — a feature-rich scientific calculator (an in-VM expression
/// engine + a responsive glass keypad) built on that same SDK.
#[cfg(feature = "calculator")]
const APP_BYTECODE: &[u8] = include_bytes!("../../liquidglass/assets/calculator.bc");
#[cfg(all(feature = "liquidglass", not(feature = "calculator")))]
const APP_BYTECODE: &[u8] = include_bytes!("../../liquidglass/assets/demo.bc");
#[cfg(all(feature = "game3d", not(feature = "liquidglass"), not(feature = "calculator")))]
const APP_BYTECODE: &[u8] = include_bytes!("../../game3d/assets/demo.bc");
#[cfg(all(not(feature = "game3d"), not(feature = "liquidglass"), not(feature = "calculator")))]
const APP_BYTECODE: &[u8] = include_bytes!("../../material/assets/gallery.bc");

/// The winit window title for the embedded app.
#[cfg(feature = "calculator")]
const WINDOW_TITLE: &str = "Elpa — Liquid Glass calculator";
#[cfg(all(feature = "liquidglass", not(feature = "calculator")))]
const WINDOW_TITLE: &str = "Elpa — Liquid Glass demo";
#[cfg(all(feature = "game3d", not(feature = "liquidglass"), not(feature = "calculator")))]
const WINDOW_TITLE: &str = "Elpa — Game3D demo";
#[cfg(all(not(feature = "game3d"), not(feature = "liquidglass"), not(feature = "calculator")))]
const WINDOW_TITLE: &str = "Elpa — Material demo";

/// Everything that exists only while we hold a surface. On Android this is
/// recreated on each `resumed` and torn down on each `suspended`.
struct State {
    window: Arc<Window>,
    app: Rc<RefCell<App>>,
    cursor_pos: (f64, f64),
    last_frame: Option<Instant>,
    next_frame: Instant,
    redraw_pending: bool,
    pending_events: Vec<InputEvent>,
}

impl State {
    fn request_redraw(&mut self) {
        if !self.redraw_pending {
            self.redraw_pending = true;
            self.window.request_redraw();
        }
    }

    fn queue_event(&mut self, event: InputEvent) {
        // Pointer/touch move and wheel events can arrive faster than Android can
        // render. Keep only the newest contiguous move/wheel sample so input
        // delivery remains cheap and the frame uses the freshest position,
        // mirroring browser event coalescing before requestAnimationFrame.
        // Press/release and key events are kept in order because they carry
        // discrete state changes.
        match (&event, self.pending_events.last_mut()) {
            (InputEvent::PointerMove { .. }, Some(last @ InputEvent::PointerMove { .. }))
            | (InputEvent::Wheel { .. }, Some(last @ InputEvent::Wheel { .. })) => {
                *last = event;
            }
            _ => self.pending_events.push(event),
        }
        self.request_redraw();
    }
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
                .create_window(Window::default_attributes().with_title(WINDOW_TITLE))
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

        // Seed the first frame with the current safe-area insets so the UI lays
        // out clear of the status / navigation bars from the very first paint
        // (no flash of content drawn under the status bar on Android).
        let surface_info = SurfaceInfo::new(w, h, scale).with_insets(safe_area_insets(w, h));
        let mut app = Elpa::new_from_bytecode(backend, surface_info, APP_BYTECODE.to_vec())
            .expect("app bytecode loads");
        // Grant network + a blocking fetcher so the app can download a font by URL
        // at runtime (the gallery's `f` key calls `useFont(...)`).
        {
            let mut toggles = app.env().toggles();
            toggles.network = true;
            app.env_mut().set_toggles(toggles);
            app.env_mut().set_net(Box::new(NativeNet));
            // The async media engine runs this fetcher on its own worker thread, so
            // downloading + decoding an image / animated GIF never blocks the render
            // loop. `ureq` is a blocking client (fine off the render thread).
            app.env_mut().set_media_fetcher(Box::new(|url: &str| {
                let mut resp = ureq::get(url).call().map_err(|e| e.to_string())?;
                resp.body_mut().read_to_vec().map_err(|e| e.to_string())
            }));
        }
        app.start(); // run top-level program (init + first frame)

        self.state = Some(State {
            window,
            app: Rc::new(RefCell::new(app)),
            cursor_pos: (0.0, 0.0),
            last_frame: None,
            next_frame: Instant::now(),
            redraw_pending: false,
            pending_events: Vec::new(),
        });
    }
}

impl ApplicationHandler for ElpaApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        // Let the platform sleep between redraws. The old native loop used
        // `Poll`, and requesting another redraw from every `about_to_wait`
        // iteration can still flood Android with redraw work while input is
        // queued. The web example has exactly one requestAnimationFrame pending
        // at a time, so the native host tracks pending redraws and schedules the
        // next animation tick for the target frame time.
        event_loop.set_control_flow(ControlFlow::Wait);
        if self.state.is_none() {
            self.init(event_loop);
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        // Release the surface/window: on Android the native surface is gone
        // after suspend; we rebuild it on the next `resumed`.
        self.state = None;
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                let (w, h) = (size.width.max(1), size.height.max(1));
                let mut app = state.app.borrow_mut();
                app.renderer_mut().backend_mut().resize(w, h); // reconfigure swapchain
                app.resize(w, h, state.window.scale_factor()); // SurfaceInfo + app onResize
                // A resize is also when the reserved system-bar regions change
                // (rotation, bars showing/hiding), so re-report the insets. This
                // no-ops when they are unchanged.
                let ins = safe_area_insets(w, h);
                app.set_safe_area_insets(ins.top, ins.right, ins.bottom, ins.left);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = state.window.scale_factor();
                state.cursor_pos = (position.x / scale, position.y / scale);
                state.queue_event(InputEvent::PointerMove {
                    x: state.cursor_pos.0,
                    y: state.cursor_pos.1,
                });
                state.window.request_redraw();
            }
            WindowEvent::MouseInput {
                state: button_state,
                button,
                ..
            } => {
                let button = match button {
                    MouseButton::Left => 0,
                    MouseButton::Right => 1,
                    MouseButton::Middle => 2,
                    MouseButton::Back => 3,
                    MouseButton::Forward => 4,
                    MouseButton::Other(n) => n.min(u8::MAX as u16) as u8,
                };
                let event = match button_state {
                    ElementState::Pressed => InputEvent::PointerDown {
                        x: state.cursor_pos.0,
                        y: state.cursor_pos.1,
                        button,
                    },
                    ElementState::Released => InputEvent::PointerUp {
                        x: state.cursor_pos.0,
                        y: state.cursor_pos.1,
                        button,
                    },
                };
                state.queue_event(event);
            }
            WindowEvent::Touch(touch) => {
                let scale = state.window.scale_factor();
                let x = touch.location.x / scale;
                let y = touch.location.y / scale;
                state.cursor_pos = (x, y);
                let event = match touch.phase {
                    winit::event::TouchPhase::Started => {
                        InputEvent::PointerDown { x, y, button: 0 }
                    }
                    winit::event::TouchPhase::Moved => InputEvent::PointerMove { x, y },
                    winit::event::TouchPhase::Ended | winit::event::TouchPhase::Cancelled => {
                        InputEvent::PointerUp { x, y, button: 0 }
                    }
                };
                state.queue_event(event);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let delta_y = match delta {
                    MouseScrollDelta::LineDelta(_, y) => f64::from(y) * 40.0,
                    MouseScrollDelta::PixelDelta(pos) => pos.y,
                };
                state.queue_event(InputEvent::Wheel {
                    x: state.cursor_pos.0,
                    y: state.cursor_pos.1,
                    delta_y,
                });
                state.window.request_redraw();
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let key = match &event.logical_key {
                    Key::Named(NamedKey::Space) => " ".to_string(),
                    Key::Named(named) => format!("{named:?}"),
                    Key::Character(ch) => ch.to_string(),
                    Key::Unidentified(_) | Key::Dead(_) => String::new(),
                };
                let event = match event.state {
                    ElementState::Pressed => InputEvent::KeyDown { key },
                    ElementState::Released => InputEvent::KeyUp { key },
                };
                state.queue_event(event);
            }
            WindowEvent::RedrawRequested => {
                state.redraw_pending = false;

                // Treat one redraw as one frame-computation budget. Input can
                // already repaint (and global theme changes can be expensive), so
                // if queued input consumes the frame budget, drop this frame's
                // animation computation instead of immediately building a
                // catch-up backlog. The next scheduled redraw advances animation
                // with the real elapsed time.
                let frame_start = Instant::now();
                let events = std::mem::take(&mut state.pending_events);
                let had_input = !events.is_empty();
                for event in events {
                    state.app.borrow_mut().send_event(&event);
                }

                let input_elapsed = frame_start.elapsed();
                if !had_input || input_elapsed < TARGET_FRAME_TIME {
                    let dt = state
                        .last_frame
                        .map(|last| frame_start.duration_since(last).as_secs_f64() * 1_000.0)
                        .unwrap_or(16.0)
                        .min(MAX_ANIMATION_DT_MS);
                    state.last_frame = Some(frame_start);
                    state.app.borrow_mut().animate(dt);
                }

                // Schedule relative to the end of computation, not its start. If
                // the VM/render work took longer than a frame, this intentionally
                // drops catch-up frame computations and gives Android input and
                // presentation time before the next tick.
                state.next_frame = Instant::now() + TARGET_FRAME_TIME;
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(state) = self.state.as_mut() {
            let now = Instant::now();
            if now >= state.next_frame {
                state.request_redraw();
                event_loop.set_control_flow(ControlFlow::Wait);
            } else {
                event_loop.set_control_flow(ControlFlow::WaitUntil(state.next_frame));
            }
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

    // Keep a handle so the render loop can read the live content rectangle (the
    // source of the safe-area insets) on resize; winit does not expose it again.
    let _ = ANDROID_APP.set(android_app.clone());

    let event_loop = EventLoop::builder()
        .with_android_app(android_app)
        .build()
        .expect("build android event loop");
    run(event_loop);
}
