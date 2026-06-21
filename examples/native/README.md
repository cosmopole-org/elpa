# Elpa native example (desktop + Android)

Runs an Elpa app in a **[winit]** window and draws its wgpu frames to the
window's surface. **By default it runs the Liquid Glass calculator**
([`examples/liquidglass`](../liquidglass)) — a feature-rich scientific calculator
built on the `elpa-liquidglass` SDK. Other apps are one `--features` flag away
(see [Run a different app](#run-a-different-app)).

One codebase targets **desktop (Windows/macOS/Linux) and Android**:

- [`../liquidglass/assets/`](../liquidglass/assets) — the default app: the Liquid
  Glass SDK (`sdk/*.js`) + the `calculator.js` app, linked into this native host.
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

A window opens with the **Liquid Glass calculator**. Tap the keys (they press in
with a tactile scale), switch BASIC/SCIENTIFIC, toggle DEG/RAD and the theme, or
drive it from the keyboard — digits, `+ - * / ^ ! % ( )`, `Enter`/`=`,
`Backspace`, `Escape`, and `s` (scientific) / `r` (DEG·RAD) / `d` (theme).
Resizing reconfigures the swapchain and asks the SDK to relayout.

### Run a different app

The same host can embed any of the other example apps by enabling exactly one
feature (each swaps in that app's precompiled bytecode):

```bash
cargo run --release --features material      # Material Design 3 gallery
cargo run --release --features liquidglass   # Liquid Glass UI kit showcase
cargo run --release --features game3d        # Game3D engine demo (island village)
# (Android: swap `cargo run` for `cargo apk run`.)
```

Regenerate an app's bytecode after editing its SDK/app with the owning crate's
generator, e.g. `cargo run -p elpa-liquidglass --bin build_bytecode` (calculator
+ showcase), `cargo run -p elpa-game3d --bin build_bytecode`, or
`cargo run -p elpa-material --bin build_bytecode`. The on-demand
[`Build APK`](../../.github/workflows/android-apk.yml) workflow packages any of
them (pick the `app`) and commits the signed APK to the repo root
(`elpa-calculator.apk` by default, `elpa.apk` for Material, etc.).

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
[`Cargo.toml`](Cargo.toml) (package id, min/target SDK, app label, and the
`android.permission.INTERNET` permission the manifest needs so the demo's
font download works on a device — see the network note below).

## Notes

- `wgpu`'s default features provide the native backends: **DX12/Vulkan** on
  Windows, **Vulkan/GLES** on Android, **Metal** on macOS, **Vulkan/GLES** on
  Linux. The surface color format is read from the live surface and patched into
  the linked Material JavaScript so the pipeline target always matches.
- **Safe area / status bar.** The Android surface is drawn edge-to-edge, so the
  host reads the activity's content rectangle (`AndroidApp::content_rect`),
  derives the system-bar insets (status bar, navigation / gesture bar, display
  cutouts) and reports them through `SurfaceInfo`'s safe-area insets — at startup
  and again on every resize/rotation via `Elpa::set_safe_area_insets`. The
  Material kit's `Scaffold` then extends the app bar's surface under the status
  bar while keeping its title/actions below it, and lifts the navigation bar
  above the gesture inset; the `SafeArea` widget does the same for custom
  content. On desktop the insets are always zero, so the layout is unchanged.
- **Network / font download.** The gallery's `f` key downloads a font by URL
  (`useFont(...)`), and the demo can also issue `httpGet`s. Two things must be
  granted for that to work: the **Elpa sandbox** must have its `network` toggle
  on with a fetcher installed (the host does this in `src/lib.rs` via
  `toggles.network = true` + `set_net(...)`), **and** the **Android app** must
  hold the `android.permission.INTERNET` permission (declared under
  `[[package.metadata.android.uses_permission]]` in `Cargo.toml`). Without the
  manifest permission the socket call fails on a device even though the sandbox
  allows it. The URLs are HTTPS, so no cleartext-traffic exception is required.
- This crate is intentionally **excluded from the workspace** (it pulls the full
  wgpu + winit stack); build it on its own as shown above.

[winit]: https://github.com/rust-windowing/winit
[`cargo-apk`]: https://crates.io/crates/cargo-apk
