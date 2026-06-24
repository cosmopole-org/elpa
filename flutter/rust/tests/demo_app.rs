//! End-to-end check that the shipped demo Elpa app runs on the engine and drives
//! the Flutter UI through the pipe as the Dart side expects.
//!
//! The demo is a Telegram-style messenger authored against the **Elpa SDK**
//! (`assets/app/sdk/*.js`). The Elpian VM compiles one source unit, so the SDK
//! modules and the app entry point are concatenated into a single program here —
//! the exact bundle (and order) the Dart loader builds in `lib/main.dart`
//! (`kAppSources`). A break in the SDK or the app is caught by `cargo test`
//! without a Flutter toolchain.

use elpa_bridge::engine::{channel, ElpaEngine, OutMessage};

// The SDK bundle, in dependency order, then the app entry point. Mirrors
// `kAppSources` in `flutter/lib/main.dart`.
const SDK_CORE: &str = include_str!("../../assets/app/sdk/00_core.js");
const SDK_THEME: &str = include_str!("../../assets/app/sdk/01_theme.js");
const SDK_WIDGETS: &str = include_str!("../../assets/app/sdk/02_widgets.js");
const SDK_REACTIVE: &str = include_str!("../../assets/app/sdk/03_reactive.js");
const SDK_TIMING: &str = include_str!("../../assets/app/sdk/04_timing.js");
const SDK_GRAPHICS: &str = include_str!("../../assets/app/sdk/05_graphics.js");
const SDK_NAV: &str = include_str!("../../assets/app/sdk/06_navigation.js");
const SDK_APP: &str = include_str!("../../assets/app/sdk/07_app.js");
const APP_MAIN: &str = include_str!("../../assets/app/main.js");

/// The full program the VM compiles: SDK modules + the app, joined like the loader.
fn bundle() -> String {
    [
        SDK_CORE, SDK_THEME, SDK_WIDGETS, SDK_REACTIVE, SDK_TIMING, SDK_GRAPHICS, SDK_NAV, SDK_APP,
        APP_MAIN,
    ]
    .join("\n")
}

/// The first JSON string value that begins with `value_prefix` (e.g. a generated
/// handler id `scope.chatlist#0`), so a test can drive a widget without
/// hard-coding the index.
fn first_value_starting_with(payload: &str, value_prefix: &str) -> Option<String> {
    let pos = payload.find(value_prefix)?;
    let rest = &payload[pos..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// The value of the first `"key":"..."` pair, by key (used for unique event keys
/// like `onSubmitted`).
fn value_for_key(payload: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let pos = payload.find(&needle)? + needle.len();
    let rest = &payload[pos..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Drain all messages on a channel into one big string (for substring asserts).
fn joined(out: &[OutMessage], ch: &str) -> String {
    out.iter().filter(|m| m.channel == ch).map(|m| m.payload.clone()).collect::<Vec<_>>().join("|")
}

/// Open the first chat from a chat-list render; returns the conversation render.
fn open_first_chat(engine: &mut ElpaEngine, list_render: &str) -> String {
    let tap = first_value_starting_with(list_render, "scope.chatlist#")
        .expect("a chat row exposes a tap handler");
    let event = format!("{{\"handler\":\"{tap}\"}}");
    let out = engine.post_event(&event);
    joined(&out, channel::RENDER)
}

#[test]
fn demo_app_boots_into_the_chat_list() {
    let mut engine =
        ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).expect("SDK+app bundle compiles");

    // Start → a full render of the chat-list page, plus a `flutter.tick` request
    // (the chat list starts its ambient-message timer in `onEnter`).
    let out = engine.start();
    let render = joined(&out, channel::RENDER);
    assert!(!render.is_empty(), "a full render is emitted on start");
    assert!(render.contains("\"Scaffold\""), "root is a Scaffold");
    assert!(render.contains("Telegram"), "the chat-list title is present");
    assert!(render.contains("Alice Johnson"), "a seeded chat is rendered");
    assert!(render.contains("Saved Messages"), "saved-messages chat is rendered");
    assert!(out.iter().any(|m| m.channel == "flutter.tick"), "ticker requested");
}

#[test]
fn tapping_a_chat_opens_the_conversation() {
    let mut engine = ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).unwrap();
    let start = engine.start();
    let list_render = joined(&start, channel::RENDER);

    let render = open_first_chat(&mut engine, &list_render);
    assert!(!render.is_empty(), "opening a chat triggers a full re-render");
    assert!(render.contains("\"TextField\""), "the conversation shows a composer field");
    assert!(render.contains("scope.messages"), "the message-list scope is mounted");
    assert!(render.contains("scope.composer"), "the composer scope is mounted");
}

#[test]
fn sending_a_message_patches_only_the_message_scope() {
    let mut engine = ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).unwrap();
    let start = engine.start();
    let list_render = joined(&start, channel::RENDER);
    let chat_render = open_first_chat(&mut engine, &list_render);

    // The composer reports the typed text on submit; fire onSubmitted with a value.
    let submit = value_for_key(&chat_render, "onSubmitted")
        .expect("composer exposes an onSubmitted handler");
    let event = format!("{{\"handler\":\"{submit}\",\"value\":\"Hello from the test\"}}");
    let out = engine.post_event(&event);

    // Sending appends the message and patches ONLY the message-list scope.
    let patches = joined(&out, channel::PATCH);
    assert!(patches.contains("\"key\":\"scope.messages\""), "patch targets the message scope");
    assert!(patches.contains("Hello from the test"), "the sent message is in the patch");
}

#[test]
fn a_peer_reply_arrives_on_a_host_timer() {
    let mut engine = ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).unwrap();
    let start = engine.start();
    let list_render = joined(&start, channel::RENDER);
    let chat_render = open_first_chat(&mut engine, &list_render);
    let submit = value_for_key(&chat_render, "onSubmitted").unwrap();
    engine.post_event(&format!("{{\"handler\":\"{submit}\",\"value\":\"ping\"}}"));

    // The peer "types…" then replies on a host timer (~1.8s). Advance frames and
    // collect: a typing-status patch should appear, and eventually a reply patch
    // into the message scope.
    let mut saw_status_patch = false;
    let mut saw_reply = false;
    for _ in 0..200 {
        let out = engine.frame(16.0);
        let patches = joined(&out, channel::PATCH);
        if patches.contains("scope.chatstatus") {
            saw_status_patch = true;
        }
        // A reply (not our own send) shows up as a later message-scope patch.
        if patches.contains("scope.messages") {
            saw_reply = true;
        }
    }
    assert!(saw_status_patch, "the typing indicator patched the status scope");
    assert!(saw_reply, "a peer reply patched the message scope on a timer");
}

/// The shell drives `onResize` and `onEvent` (raw pointers) on every build; the
/// demo implements `onHostMessage`/`onFrame`/`onResize`. Driving these must not
/// poison the VM (a panic mid-turn silently freezes the app). After those calls
/// the real handlers must still work.
#[test]
fn lifecycle_handlers_do_not_poison_the_vm() {
    let mut engine = ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).unwrap();
    let start = engine.start();
    let list_render = joined(&start, channel::RENDER);

    use elpa_bridge::engine::Pointer;
    engine.resize(720, 1280, 2.0);
    engine.safe_area(96.0, 0.0, 48.0, 0.0);
    engine.pointer(Pointer::Down, 10.0, 10.0, 0);
    engine.pointer(Pointer::Up, 10.0, 10.0, 0);

    // The VM is not poisoned: opening a chat still works after those calls.
    let conversation = open_first_chat(&mut engine, &list_render);
    assert!(
        conversation.contains("\"TextField\""),
        "the app still responds after lifecycle calls"
    );
}
