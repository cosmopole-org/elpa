# __APP_TITLE__

A **Flutter Elpa** project: a cross-platform Flutter app that embeds the **Elpa**
engine through a **flutter_rust_bridge** boundary. The application logic is
authored in **JavaScript**, runs on the Elpian VM, and is streamed to **real
Flutter widgets** over a message pipe. The demo is a rich **2D UI** dashboard.

The complete Elpa engine (the VM + renderer) and the Flutter bridge are vendored
into this project, so it builds on its own.

## Layout

| Path | What it is |
|------|------------|
| `engine/` | The vendored Elpa engine (VM + renderer + runtime) — a self-contained Cargo workspace. |
| `rust/` | The `flutter_rust_bridge` native crate that drives the VM and pipes messages to Dart. |
| `lib/` | The Dart app: the engine adapter, the DSL → widget machinery, and the shell. |
| `assets/app/sdk/` | The **Elpa SDK** — an object-oriented authoring layer (widgets, components, theme, timing, navigation, graphics). |
| `assets/app/main.js` | **The demo** — this project's app: a 2D dashboard (counter, greeter, task list, live theme switch). |

## Setup

```bash
# Prerequisites: the Flutter SDK, a Rust toolchain, and the codegen tool.
cargo install flutter_rust_bridge_codegen   # must match rust/Cargo.toml's flutter_rust_bridge
dart pub global activate ffigen

# 1. Materialize the platform runner folders (android/ios/linux/macos/windows/web).
flutter create . --platforms=android,ios,linux,macos,windows,web --project-name __APP_SNAKE__

# 2. Generate the flutter_rust_bridge bindings (lib/src/rust/** + rust/src/frb_generated.rs),
#    then uncomment `mod frb_generated;` in rust/src/lib.rs.
flutter_rust_bridge_codegen generate

# 3. Fetch deps and run.
flutter pub get
flutter run            # add -d chrome / -d linux / -d macos / a device id
```

Getting the native crate **into** each platform build is a separate step that
`flutter create` does not do on its own — see the upstream Flutter README in this
repo's history for the per-platform recipes (Android `cargo ndk` → `jniLibs/`,
web `flutter_rust_bridge_codegen build-web`), or run
`flutter_rust_bridge_codegen integrate` once to have cargokit build it on every
`flutter run`.

## The demo

`assets/app/main.js` is a single-screen dashboard built on the Elpa SDK:

- a **counter** card with +/- buttons,
- a **greeter** card whose text field echoes a live greeting,
- a **task list** you can add to and tick off,
- a **dark / light theme switch** in the header.

Each interactive card is an isolated **Component** (its own repaint scope), so a
tap patches only that card — the rest of the tree is neither re-serialized nor
repainted. Edit `assets/app/main.js` and hot-restart to iterate.

## Tests

```bash
cd rust && cargo test --no-default-features   # engine core, no Flutter toolchain needed
cd .. && flutter test                         # DSL → widget rendering, via a fake bridge
```

---

*Scaffolded with `create-elpa-app` (template: `flutter`).*
