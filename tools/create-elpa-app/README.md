# create-elpa-app

A command-line scaffolder for new **Elpa** applications. It generates a complete,
self-contained project from one of three templates, vendoring the live Elpa
engine sources out of this repository so the generated project builds on its own.

## Usage

```bash
# Interactive (prompts for a name and a template):
node tools/create-elpa-app/create-elpa-app.mjs

# Direct:
node tools/create-elpa-app/create-elpa-app.mjs my-app --template wgpu
node tools/create-elpa-app/create-elpa-app.mjs my-app -t flutter --dir ./out/my-app
```

Or install the `create-elpa-app` bin (from this directory) and run it by name:

```bash
cd tools/create-elpa-app && npm link
create-elpa-app my-app -t wgpu-flutter
```

### Options

| Flag | Meaning |
|------|---------|
| `<name>` | Project name (becomes the crate / package name in `snake_case`). |
| `-t, --template <type>` | `wgpu`, `flutter`, or `wgpu-flutter`. |
| `--dir <path>` | Output directory (default `./<name>`). |
| `--elpa-root <path>` | Path to the Elpa checkout to vendor from (auto-detected by default). |
| `--force` | Write into a non-empty directory. |
| `-h, --help` | Show help. |

## Templates

### `wgpu` — pure Elpa/JS on wgpu
A JavaScript Elpa app that runs directly on the Elpian VM and renders through
wgpu, hosted in a native `winit` window. Ships the **Game3D** and **Material**
SDKs; the demo combines a **3D game scene** with a **2D UI overlay**.

```
cd <project>/app && cargo run --release
```

### `flutter` — Flutter + flutter_rust_bridge + Elpa
A cross-platform Flutter app that embeds Elpa through a `flutter_rust_bridge`
boundary. The app logic is JavaScript on the VM, streamed to **real Flutter
widgets** over the message pipe. The demo is a rich **2D UI** dashboard. The Elpa
engine and the bridge source are vendored in.

### `wgpu-flutter` — Flutter + Elpa with a 3D Native3DView
The Flutter stack above, where the demo additionally hosts a **3D scene** rendered
by Elpa's wgpu pipeline inside an `Native3DView` (the zero-copy surface linking
wgpu to Flutter) alongside its 2D UI.

## What gets generated

Every project vendors the five core Elpa crates (`elpa`, `elpian-vm`,
`elpa-protocol`, `elpa-renderer`, `elpa-runtime`) into an `engine/` Cargo
workspace, so it builds without the original repository. The Flutter templates
additionally copy the live Flutter bridge crate, the Dart shell, and the Elpa
SDK, and repoint their dependencies at the vendored `engine/`.

Each generated project has its own `README.md` with the full walkthrough.

## How it works

The CLI is a zero-dependency Node script (`create-elpa-app.mjs`). The
`templates/` directory holds only the per-project skeleton files (with
`__APP_NAME__` / `__APP_SNAKE__` / `__APP_TITLE__` tokens); the live engine, SDK,
and Flutter sources are copied from the repository at generation time, so
templates never drift from the engine they target.
