# Elpa + Rust + Flutter

A cross-platform (mobile / desktop / web) Flutter application that embeds the
**Elpa** engine through a **flutter_rust_bridge** boundary. It is a high-performance
proxy UI controller and renderer for Rust/Elpa code:

- the **Elpian VM** runs the application's program logic (authored in JavaScript);
- a **message pipe** carries custom messages between the JS on the VM and the
  Flutter/Dart app, in both directions, with payloads moved as raw JSON text
  (single parse on each end);
- the **Elpa Flutter DSL** lets the app stream a real Flutter widget tree — built,
  cached, and decoupled into repaint boundaries so the whole UI is not re-rendered
  on every frame;
- the optional **native Elpa widget** composites Elpa's own `wgpu` rendering inline
  via a **zero-copy** Flutter `Texture` (or a platform view on web).

```
┌────────────────────────────── Flutter (Dart) ──────────────────────────────┐
│  ElpaApp → ElpaShell                                                        │
│    • subscribes to flutter.render / patch / invalidate / define             │
│    • DSL → Flutter widgets via ElpaWidgetRegistry                           │
│    • WidgetCache (rev memoization) + ElpaBoundary (RepaintBoundary)         │
│    • forwards pointer/scroll/key + semantic events                          │
│        │  ElpaEngine ─ ElpaPipe (per-channel streams + send-to-VM)          │
└────────┼────────────────────────────────────────────────────────────────────┘
         │  flutter_rust_bridge (sync calls; Vec<FfiMessage> returns)
┌────────┼────────────────── elpa_bridge (Rust) ──────────────────────────────┐
│  api::*  (handle registry — only u64 + strings cross FFI)                    │
│  engine::ElpaEngine  → drives elpa::Elpa, drains host.send, posts inbound    │
│  render::*           → optional wgpu zero-copy texture (gpu feature)         │
└────────┼────────────────────────────────────────────────────────────────────┘
         │  elpa crate: host.send / host.request / onHostMessage pipe
┌────────┴──────────────────── Elpa / Elpian VM ──────────────────────────────┐
│  app program logic (JS) → askHost("host.send", ["flutter.render", tree])     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Layout

| Path | What it is |
|------|------------|
| `rust/` | The flutter_rust_bridge native crate `elpa_bridge` (depends on `elpa`). |
| `rust/src/engine.rs` | The Elpa engine wrapper + message-pipe transport (pure Rust, unit-tested). |
| `rust/src/api/mod.rs` | The FRB surface: a `u64`-handle registry; `#[frb(sync)]` drive calls. |
| `rust/src/render.rs` | The optional wgpu zero-copy native-widget integration. |
| `rust/tests/demo_app.rs` | End-to-end test running the shipped SDK + messenger demo bundle. |
| `lib/src/elpa/bridge.dart` | The `ElpaBridge` interface the UI depends on (generation-independent). |
| `lib/src/elpa/bridge_rust.dart` | The adapter to the FRB-generated bindings. |
| `lib/src/elpa/engine.dart` / `message_pipe.dart` | The Dart engine + per-channel pipe. |
| `lib/src/elpa/dsl/` | The DSL node model, widget builders, and caching/boundary machinery. |
| `lib/src/elpa/native/elpa_texture.dart` | The zero-copy `Texture` / `HtmlElementView` widget. |
| `lib/src/elpa/elpa_shell.dart` | The shell that turns the DSL stream into a cached Flutter tree. |
| `assets/app/sdk/` | The **Elpa SDK**: an OO authoring layer (core/theme/widgets/reactive/timing/graphics/navigation/app). |
| `assets/app/main.js` | The demo Elpa app — a Telegram-style messenger built on the SDK, driven over the pipe. |

## The messaging pipe

The pipe is built on three pieces added to the core engine:

- **`elpian-vm`** registers the `host.send` / `host.request` host APIs and exposes
  `deliver_host_message` (which invokes the guest's `onHostMessage`).
- **`elpa`** routes `host.send` into an outbound queue
  (`Elpa::take_outbound_messages`), answers `host.request` via an installed
  responder, and delivers inbound messages with `Elpa::post_message`.
- **`elpa_bridge`** turns every drive call (start / event / frame / inbound post)
  into the list of messages the app emitted during that turn, returned synchronously
  to Dart, where `ElpaPipe` fans them out to per-channel `Stream`s.

Reserved channels (Rust is the source of truth; Dart reads them at startup):

| Channel | Direction | Meaning |
|---------|-----------|---------|
| `flutter.render` | app → UI | full or sub-tree to render |
| `flutter.patch` | app → UI | replace the subtree with a given `key` |
| `flutter.invalidate` | app → UI | drop a cached node's memo |
| `flutter.define` | app → UI | register a reusable custom widget |
| `flutter.event` | UI → app | a tap / change / gesture (carries the callback id) |

## Caching & scoping — why the whole UI is not rebuilt each frame

- **Render scopes (true per-widget rerenders)** — a node marked `"boundary": true`
  becomes an `ElpaScope`: a self-contained `StatefulWidget`, wrapped in a
  `RepaintBoundary`, registered by key in a `ScopeRegistry`. A `flutter.patch` (or
  `flutter.invalidate`) addressed to that key is routed straight to *that scope's
  own* `setState` — **the shell never rebuilds**. Flutter marks only that Element
  dirty and the `RepaintBoundary` confines the repaint, so a state change in one
  scope rerenders only it; sibling and ancestor scopes are neither rebuilt nor
  repainted. (If no scope is mounted for the key, the shell falls back to a full
  rebuild, so the model stays correct.)
- **Revision memoization** — within any scope, a node carrying a `rev` reuses its
  previously-built `Widget` while `rev` is unchanged, so Flutter short-circuits that
  branch's rebuild. An app bumps `rev` only where state changed.
- **Keyed identity** — every node has a stable `key`, so reordering reuses elements
  and their state rather than recreating them.
- **Lazy lists** — `ListView` builds children through `itemBuilder`, so off-screen
  rows are never built.

The demo (`assets/app/main.js`) is a Telegram-style messenger built on the **Elpa
SDK** (`assets/app/sdk/`): a chat list, conversations with message bubbles and read
receipts, a real text composer, settings with a live dark/light theme switch, and
navigation between them. Each live region is its own render scope — the message
list, the chat-header status (animated "typing…"), the composer, and the chat list
itself — so sending a message patches only the message scope, and an incoming
message patches only the affected list row. Timing rides the host frame pump (the
SDK `Scheduler`): peer replies arrive on a timer and the typing indicator animates.
The Rust end-to-end test (`rust/tests/demo_app.rs`) compiles the exact SDK + app
bundle and asserts the scoped-patch contract; the Dart widget test
(`test/elpa_shell_test.dart`) proves a patch to one scope leaves a sibling's build
count unchanged.

### The Elpa SDK

App logic is authored against an object-oriented SDK rather than hand-written JSON.
It is a set of modules concatenated into one VM program (`lib/main.dart`
`kAppSources`):

| Module | What it provides |
|--------|------------------|
| `00_core.js` | `Host` (typed `askHost` facade), `EventBus` (closures ⇄ wire handler ids), `BuildEnv`. |
| `01_theme.js` | `Theme` — Telegram dark/light palettes, spacing, radii, typography, avatar colours. |
| `02_widgets.js` | `Widget` base + fluent widget classes (Text, Column, Container, ListView, Button, Field, Avatar, …). |
| `03_reactive.js` | `Component` (isolated, self-patching render scope), `Signal`, `Store`. |
| `04_timing.js` | `Scheduler` (host-frame-driven `setTimeout`/`setInterval`), `Animation`, easing. |
| `05_graphics.js` | `Gpu`/`FrameBuilder` over the wgpu pipe, `Scene3D`/`Camera`/`Mesh`/`Material`, `Native3DView`. |
| `06_navigation.js` | `Page`, `Navigator` — a stack router with lifecycle hooks. |
| `07_app.js` | `App` — the runtime that owns the services and drives render/patch. |

## The native Elpa widget (zero-copy wgpu)

The `ElpaNative` DSL node maps to `ElpaNativeView`, which composites Elpa's own
`wgpu` output **inline** with no CPU copy:

- mobile/desktop → Flutter's `Texture(textureId)` samples a GPU texture Elpa renders
  into (Android `HardwareBuffer`, iOS/macOS `IOSurface`/`CVPixelBuffer`, Linux
  DMA-BUF, Windows DXGI shared handle);
- web → Elpa's wgpu canvas is hosted as an `HtmlElementView`.

The platform-specific shared-texture wiring lives behind the `gpu` Cargo feature in
`rust/src/render.rs::register_surface`; the default build runs headless and the UI
comes entirely from the DSL pipe.

## Setup

This folder contains the **source of truth** (Dart logic + Rust bridge + config).
The platform runner folders and the FRB-generated bindings are produced by standard
tooling:

```bash
# 0. Prerequisites: Flutter SDK, Rust toolchain, and the codegen tool.
cargo install flutter_rust_bridge_codegen          # must match rust crate's `flutter_rust_bridge = "2"`
dart pub global activate ffigen

cd flutter

# 1. Materialize platform runners (android/ios/linux/macos/windows/web).
flutter create . --platforms=android,ios,linux,macos,windows,web --project-name elpa_app

# 2. Generate the FRB bindings (lib/src/rust/** and rust/src/frb_generated.rs),
#    then uncomment `mod frb_generated;` in rust/src/lib.rs.
flutter_rust_bridge_codegen generate

# 3. Fetch Dart deps and run.
flutter pub get
flutter run            # add -d chrome / -d linux / -d macos / a device id
```

Getting the native crate **into** each platform build is a separate step —
`flutter create` does **not** wire it up on its own (only
`flutter_rust_bridge_codegen integrate`, which scaffolds the cargokit hooks,
does). The CI workflows therefore build and place the library themselves:

- **Android** (`.github/workflows/flutter-android-apk.yml`): `cargo ndk` cross-
  compiles the crate for each ABI into `android/app/src/main/jniLibs/<abi>/`,
  which Gradle bundles automatically. The library is named `libelpa_bridge.so`,
  matching the loader stem FRB derives from the crate's `lib` target.
- **Web** (`.github/workflows/flutter-web-pages.yml`):
  `flutter_rust_bridge_codegen build-web` compiles the crate to wasm under
  `web/pkg`. It is built **single-threaded** (`--wasm-pack-rustflags` dropping
  `+atomics`): FRB's default is a multi-threaded, shared-memory module that only
  loads on a cross-origin-isolated page *and* traps (`RuntimeError: unreachable`)
  when its synchronous FFI blocks on the browser's main thread. This app makes
  only `#[frb(sync)]` calls, so a single-threaded module is both correct and
  hostable on any static host (GitHub Pages) with no special headers.

If you'd rather have the standard cargokit integration build the library on every
`flutter run`/`flutter build`, run `flutter_rust_bridge_codegen integrate` once
and commit the generated `rust_builder/` package.

To build with the GPU native-widget path, build the Rust crate with
`--features gpu` (the default build runs headless and drives the UI purely
through the DSL pipe).

## Tests

```bash
# Rust: engine core + the real demo app, no Flutter toolchain needed.
cd rust && cargo test --no-default-features

# Dart: DSL → widget rendering and the cache, via a fake bridge.
cd .. && flutter test
```
