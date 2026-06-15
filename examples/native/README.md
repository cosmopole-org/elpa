# Elpa native example (desktop + Android)

Runs the Elpa **Material Design 3 SDK demo** in a **[winit]** window and draws
its wgpu frames to the window's surface. The native desktop and Android builds
now link the JavaScript Material SDK from [`examples/material`](../material) and
run its interactive demo, so the APK shows the same Material controls you can
exercise in the SDK demo.

One codebase targets **desktop (Windows/macOS/Linux) and Android**:

- [`../material/assets/elpa-material.js`](../material/assets/elpa-material.js) — the
  Material SDK linked into this native app.
- [`../material/assets/demo.js`](../material/assets/demo.js) — the interactive
  demo script linked after the SDK.
- [`src/lib.rs`](src/lib.rs) — the cross-platform window + render loop. The
  window and GPU surface are created lazily in `resumed` and dropped in
  `suspended`, which is **required on Android** (the native surface only exists
  between those callbacks) and works unchanged on desktop. Also holds the
  Android `android_main` entry point.
- [`src/main.rs`](src/main.rs) — the desktop binary entry point.

The crate is built as a `cdylib` for Android and as a normal binary for desktop.

## Desktop (Windows / macOS / Linux)

```bash
cd examples/native
cargo run --release            # build & run on the host OS
```

A window opens with the Material demo. Click/tap controls, drag the slider, use
the mouse wheel where supported, or press `d`, `Space`, `r`, `ArrowLeft`, and
`ArrowRight` to exercise the demo keyboard handlers. Resizing reconfigures the
swapchain and asks the SDK to relayout.

### Cross-compiling to Windows from Linux

```bash
rustup target add x86_64-pc-windows-gnu
sudo apt-get install -y gcc-mingw-w64-x86-64      # the mingw linker
cargo build --release --target x86_64-pc-windows-gnu
# -> target/x86_64-pc-windows-gnu/release/elpa-native-example.exe
```

(On a Windows host, the default `x86_64-pc-windows-msvc` target works with no
extra setup.)

## Android

The build needs the **Android NDK** (for cross-compiling/linking) and, to
package an APK, the **Android SDK** + [`cargo-apk`].

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android

export ANDROID_NDK_HOME=/path/to/android-ndk      # e.g. android-ndk-r26d
export ANDROID_HOME=/path/to/android-sdk
```

### Compile the native library (no SDK required)

```bash
cargo install cargo-ndk
cargo ndk -t arm64-v8a build --release --lib
# -> target/aarch64-linux-android/release/libelpa_native_example.so
```

The `.so` exports `android_main` and `ANativeActivity_onCreate` — the entry
points Android's `NativeActivity` loads.

### Build an installable APK

```bash
cargo install cargo-apk
# `--lib` packages the Android cdylib (this crate also has a desktop binary).
cargo apk build --lib            # APK metadata lives in Cargo.toml
# -> target/debug/apk/elpa_native_example.apk  (signed with a debug key)
cargo apk run --lib              # build, install, and launch on a connected device
```

A `--release` APK must be signed. Point cargo-apk at a keystore via environment
variables (what CI does — no secrets in the repo):

```bash
keytool -genkeypair -keystore release.keystore -alias elpa -keyalg RSA \
  -keysize 2048 -validity 10000 -storepass android -keypass android \
  -dname "CN=Elpa, O=Cosmopole, C=US"
export CARGO_APK_RELEASE_KEYSTORE="$PWD/release.keystore"
export CARGO_APK_RELEASE_KEYSTORE_PASSWORD=android
cargo apk build --release --lib   # -> ~3 MB signed APK
```

CI builds this APK on every push and commits it to the repo root as `elpa.apk`
(see [`.github/workflows/android-apk.yml`](../../.github/workflows/android-apk.yml)).

APK packaging is configured under `[package.metadata.android]` in
[`Cargo.toml`](Cargo.toml) (package id, min/target SDK, app label).

## Notes

- `wgpu`'s default features provide the native backends: **DX12/Vulkan** on
  Windows, **Vulkan/GLES** on Android, **Metal** on macOS, **Vulkan/GLES** on
  Linux. The surface color format is read from the live surface and patched into
  the linked Material JavaScript so the pipeline target always matches.
- This crate is intentionally **excluded from the workspace** (it pulls the full
  wgpu + winit stack); build it on its own as shown above.

[winit]: https://github.com/rust-windowing/winit
[`cargo-apk`]: https://crates.io/crates/cargo-apk
