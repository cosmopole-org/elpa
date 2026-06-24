//! Desktop entry point (Windows/macOS/Linux). The cross-platform window + render
//! logic lives in the library (`lib.rs`); Android enters through its
//! `android_main` instead. See `README.md`.

fn main() {
    env_logger::init();
    let event_loop = winit::event_loop::EventLoop::new().expect("create event loop");
    elpa_native_example::run(event_loop);
}
