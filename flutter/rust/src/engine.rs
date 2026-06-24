//! The **Elpa engine wrapper** that the flutter_rust_bridge API layer exposes to
//! Dart. It owns one [`Elpa`] instance, drives its lifecycle, and converts the
//! instance's custom messaging pipe into a flat, FRB-friendly form.
//!
//! This module has **no** `flutter_rust_bridge` dependency: it is plain Rust that
//! can be unit-tested with `cargo test` and reused by any host. The thin
//! `api::*` layer wraps these methods with `#[frb]` so codegen can bind them to
//! Dart.
//!
//! ## How the pipe is wired
//!
//! The JS app running on the Elpian VM talks to the Flutter host entirely through
//! Elpa's custom messaging pipe (`elpa::host_message`):
//!
//! * **guest → host** — the app calls `host.send(channel, message)`. Every drive
//!   call ([`ElpaEngine::start`], [`ElpaEngine::pointer`], [`ElpaEngine::frame`],
//!   [`ElpaEngine::post`], …) returns the [`OutMessage`]s the app emitted during
//!   that turn, so the bridge can forward them to a Dart `StreamSink` with no
//!   polling and no extra parse — the payload is moved as a `String`.
//! * **host → guest** — the bridge calls [`ElpaEngine::post`], which delivers a
//!   `{channel, message}` object to the app's `onHostMessage` and pumps whatever
//!   the app does in response through the same loop.
//!
//! The **Elpa flutter DSL** (the widget tree the app wants Flutter to render) is
//! just messages on reserved channels — by convention [`channel::RENDER`] for a
//! full/partial widget tree and [`channel::PATCH`] for a targeted update. Input
//! events flow back on [`channel::EVENT`]. Nothing about the DSL is hard-coded
//! here: the engine is a transport, and the Dart side owns the vocabulary.

use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

/// Reserved channel names for the Elpa ⇄ Flutter contract. They are plain
/// strings on the generic pipe; centralizing them keeps the Rust and Dart sides
/// in agreement.
pub mod channel {
    /// App → Flutter: a widget-tree description (full or sub-tree) to render.
    pub const RENDER: &str = "flutter.render";
    /// App → Flutter: a targeted patch to an existing node (by key).
    pub const PATCH: &str = "flutter.patch";
    /// App → Flutter: invalidate a cached render boundary (force a rebuild).
    pub const INVALIDATE: &str = "flutter.invalidate";
    /// App → Flutter: register a reusable custom-widget definition.
    pub const DEFINE: &str = "flutter.define";
    /// Flutter → App: an input/gesture/lifecycle event.
    pub const EVENT: &str = "flutter.event";
}

/// The GPU backend the engine drives. The DSL path needs no GPU, so the default
/// build uses Elpa's [`HeadlessBackend`]: the VM still runs, submits frames, and
/// — crucially — exercises the full messaging pipe. The optional `gpu` feature
/// swaps in a live wgpu backend for the native-widget (zero-copy texture) path;
/// see `render.rs` and the README for how that surface is sourced from a Flutter
/// `Texture`.
pub type Backend = HeadlessBackend;

/// One message leaving the app for the Flutter host (the guest → host leg).
/// `payload` is raw JSON text — moved, never re-parsed, by the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutMessage {
    pub channel: String,
    pub payload: String,
}

impl From<elpa::HostMessage> for OutMessage {
    fn from(m: elpa::HostMessage) -> Self {
        OutMessage { channel: m.channel, payload: m.payload }
    }
}

/// A pointer/gesture button or phase, kept as a small enum the Dart side mirrors.
#[derive(Debug, Clone, Copy)]
pub enum Pointer {
    Down,
    Move,
    Up,
}

/// The Elpa engine: one running app plus the surface metrics Flutter reports.
pub struct ElpaEngine {
    app: Elpa<Backend>,
}

impl ElpaEngine {
    /// Build an engine from JavaScript source, sized to the Flutter surface.
    /// Returns `None` if the source is outside the supported JS subset.
    pub fn from_js(js_source: &str, width: u32, height: u32, scale: f64) -> Option<Self> {
        let surface = SurfaceInfo::new(width.max(1), height.max(1), scale.max(0.1));
        let app = Elpa::new_from_js(Backend::default(), surface, js_source)?;
        Some(Self::wrap(app))
    }

    /// Build an engine from Elpian **AST JSON** (no JS front-end at load time).
    pub fn from_ast(ast_json: &str, width: u32, height: u32, scale: f64) -> Option<Self> {
        let surface = SurfaceInfo::new(width.max(1), height.max(1), scale.max(0.1));
        let app = Elpa::new(Backend::default(), surface, ast_json)?;
        Some(Self::wrap(app))
    }

    /// Build an engine from prebuilt VM **bytecode** (the shipped/deployed path).
    pub fn from_bytecode(bytecode: Vec<u8>, width: u32, height: u32, scale: f64) -> Option<Self> {
        let surface = SurfaceInfo::new(width.max(1), height.max(1), scale.max(0.1));
        let app = Elpa::new_from_bytecode(Backend::default(), surface, bytecode)?;
        Some(Self::wrap(app))
    }

    fn wrap(app: Elpa<Backend>) -> Self {
        ElpaEngine { app }
    }

    /// Run the app's top-level program (init + first render) and return the
    /// messages it emitted (typically the initial `flutter.render` tree).
    pub fn start(&mut self) -> Vec<OutMessage> {
        self.app.start();
        self.drain()
    }

    /// Forward a pointer event in logical (Flutter) coordinates. The engine
    /// converts it to an Elpa [`InputEvent`]; the app's `onEvent` may re-render,
    /// emitting render/patch messages this returns.
    pub fn pointer(&mut self, phase: Pointer, x: f64, y: f64, button: i64) -> Vec<OutMessage> {
        let button = button.clamp(0, u8::MAX as i64) as u8;
        let event = match phase {
            Pointer::Down => InputEvent::PointerDown { x, y, button },
            Pointer::Move => InputEvent::PointerMove { x, y },
            Pointer::Up => InputEvent::PointerUp { x, y, button },
        };
        self.app.send_event(&event);
        self.drain()
    }

    /// Deliver a mouse-wheel / trackpad scroll event in logical coordinates.
    pub fn wheel(&mut self, x: f64, y: f64, delta_y: f64) -> Vec<OutMessage> {
        self.app.send_event(&InputEvent::Wheel { x, y, delta_y });
        self.drain()
    }

    /// Deliver a key event. `key` is the key label Flutter reports (e.g. the
    /// `LogicalKeyboardKey.keyLabel` or a debug name), matching Elpa's string keys.
    pub fn key(&mut self, down: bool, key: String) -> Vec<OutMessage> {
        let event = if down {
            InputEvent::KeyDown { key }
        } else {
            InputEvent::KeyUp { key }
        };
        self.app.send_event(&event);
        self.drain()
    }

    /// Advance one animation tick (`onFrame(dtMs)`), returning any emitted UI.
    pub fn frame(&mut self, dt_ms: f64) -> Vec<OutMessage> {
        self.app.animate(dt_ms);
        self.drain()
    }

    /// Report a surface resize (physical pixels + device pixel ratio). The app's
    /// `onResize` re-fits and may re-emit its tree.
    pub fn resize(&mut self, width: u32, height: u32, scale: f64) -> Vec<OutMessage> {
        self.app.resize(width.max(1), height.max(1), scale.max(0.1));
        self.drain()
    }

    /// Report updated safe-area insets (status/navigation bars, cutouts), in
    /// physical pixels. A no-op for the app when unchanged.
    pub fn safe_area(&mut self, top: f64, right: f64, bottom: f64, left: f64) -> Vec<OutMessage> {
        self.app.set_safe_area_insets(top, right, bottom, left);
        self.drain()
    }

    /// Deliver a custom message into the app (host → guest) on any channel —
    /// the generic inbound leg. Flutter sends user events on [`channel::EVENT`],
    /// but any application channel works. `payload_json` is raw JSON text.
    pub fn post(&mut self, channel: &str, payload_json: &str) -> Vec<OutMessage> {
        self.app.post_message(channel, payload_json);
        self.drain()
    }

    /// Convenience: deliver a Flutter input/gesture event on [`channel::EVENT`].
    pub fn post_event(&mut self, payload_json: &str) -> Vec<OutMessage> {
        self.post(channel::EVENT, payload_json)
    }

    /// Drain whatever the app pushed via `host.send` during the latest turn.
    fn drain(&mut self) -> Vec<OutMessage> {
        self.app.take_outbound_messages().into_iter().map(OutMessage::from).collect()
    }

    /// Drained diagnostic log lines (`log(...)` from the app).
    pub fn take_log(&mut self) -> Vec<String> {
        self.app.take_log()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = r#"
        // A tiny Elpa app that drives a Flutter UI purely through the pipe.
        function render() {
          askHost("host.send", ["flutter.render", { type: "Text", text: "hi:" + count }]);
        }
        var count = 0;
        render();
        function onHostMessage(msg) {
          if (msg.channel === "flutter.event") { count = count + 1; render(); }
        }
    "#;

    #[test]
    fn start_emits_initial_render() {
        let mut e = ElpaEngine::from_js(APP, 400, 800, 2.0).expect("compiles");
        let out = e.start();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].channel, channel::RENDER);
        assert_eq!(out[0].payload, r#"{"text":"hi:0","type":"Text"}"#);
    }

    #[test]
    fn inbound_event_drives_a_rerender() {
        let mut e = ElpaEngine::from_js(APP, 400, 800, 2.0).unwrap();
        e.start();
        let out = e.post_event(r#"{"kind":"tap"}"#);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].payload, r#"{"text":"hi:1","type":"Text"}"#);
    }

    #[test]
    fn rejects_invalid_source() {
        assert!(ElpaEngine::from_js("function (", 1, 1, 1.0).is_none());
    }
}
