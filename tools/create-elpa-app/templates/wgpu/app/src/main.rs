//! __APP_TITLE__ — an Elpa app on wgpu.
//!
//! Hosts an Elpa instance in a native [`winit`] window backed by a live wgpu
//! surface, and drives it: `requestRedraw` → `animate`, resize → `resize`,
//! pointer/scroll/keyboard → `send_event`. The app program (the Game3D SDK plus
//! the demo) is concatenated by `build.rs` and compiled by the VM at startup.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use elpa::{Elpa, InputEvent, NetProvider, NetRequest, NetResponse, SurfaceInfo, WgpuBackend};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

/// The whole app program: Game3D SDK modules + the demo, concatenated by build.rs.
const PROGRAM: &str = include_str!(concat!(env!("OUT_DIR"), "/program.js"));

const WINDOW_TITLE: &str = "__APP_TITLE__";
const TARGET_FRAME_TIME: Duration = Duration::from_nanos(16_666_667);
const MAX_ANIMATION_DT_MS: f64 = 100.0;

/// A live app over a window-backed wgpu surface (`'static`, since the surface is
/// built from an `Arc<Window>` kept alive alongside it).
type App = Elpa<WgpuBackend<'static>>;

/// Blocking HTTP so an Elpa app can download a font by URL (`useFont(url)`)
/// through the host's `NetProvider` — Elpa's host-call model is synchronous and
/// `ureq` is a blocking client, so this is a direct fit.
struct NativeNet;
impl NetProvider for NativeNet {
    fn fetch(&mut self, req: &NetRequest) -> Result<NetResponse, String> {
        let mut resp = ureq::get(&req.url).call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let bytes = resp.body_mut().read_to_vec().map_err(|e| e.to_string())?;
        Ok(NetResponse { status, body: String::new(), bytes: Some(bytes) })
    }
}

/// Everything that exists only while we hold a surface.
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
        // Coalesce contiguous move/wheel samples so input stays cheap and the
        // frame uses the freshest position (browser-style event coalescing).
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
    fn init(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(Window::default_attributes().with_title(WINDOW_TITLE))
                .expect("create window"),
        );
        let size = window.inner_size();
        let (w, h) = (size.width.max(1), size.height.max(1));
        let scale = window.scale_factor();

        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let surface = instance
            .create_surface(window.clone())
            .expect("create surface from window");
        let backend = pollster::block_on(WgpuBackend::new(&instance, surface, w, h));

        let surface_info = SurfaceInfo::new(w, h, scale);
        let mut app = Elpa::new_from_js(backend, surface_info, PROGRAM)
            .expect("app program compiles and loads");
        {
            let mut toggles = app.env().toggles();
            toggles.network = true;
            app.env_mut().set_toggles(toggles);
            app.env_mut().set_net(Box::new(NativeNet));
            app.env_mut().set_media_fetcher(Box::new(|url: &str| {
                let mut resp = ureq::get(url).call().map_err(|e| e.to_string())?;
                resp.body_mut().read_to_vec().map_err(|e| e.to_string())
            }));
        }
        app.start();

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
        event_loop.set_control_flow(ControlFlow::Wait);
        if self.state.is_none() {
            self.init(event_loop);
        }
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
                app.renderer_mut().backend_mut().resize(w, h);
                app.resize(w, h, state.window.scale_factor());
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = state.window.scale_factor();
                state.cursor_pos = (position.x / scale, position.y / scale);
                state.queue_event(InputEvent::PointerMove {
                    x: state.cursor_pos.0,
                    y: state.cursor_pos.1,
                });
            }
            WindowEvent::MouseInput { state: button_state, button, .. } => {
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

fn main() {
    env_logger::init();
    let event_loop = EventLoop::new().expect("create event loop");
    let mut app = ElpaApp::default();
    event_loop.run_app(&mut app).expect("event loop failed");
}
