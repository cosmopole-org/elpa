# create-elpa-app

A command-line toolchain for **Elpa** applications authored in **TypeScript**,
written in Rust and part of the workspace. It scaffolds a project, transpiles +
bundles the TypeScript to a single VM-subset script, and compiles that to Elpian
bytecode — plus a dev server for the prebuilt wasm host.

```bash
cargo run -p create-elpa-app -- <command> [args]
# or build once and call the binary:
cargo build -p create-elpa-app --release
./target/release/create-elpa-app <command> [args]
```

## Commands

| Command | What it does |
|---------|--------------|
| `init <name> [-t <template>]` | Scaffold a project (vendors the engine + SDK), then build it once. Prompts interactively if `name`/template are omitted. |
| `build` | Transpile the TypeScript app → one VM-subset JS bundle (`app.js`) **and** its Elpian bytecode (`app.bc`). |
| `dev [--port N]` | `build`, then serve the bytecode over HTTP for the prebuilt Elpa + Flutter wasm host. |
| `install [--dry-run] [--skip-host] [--force]` | **One-shot environment setup.** Detects and installs everything missing — the Rust wasm target, `wasm-bindgen`, `flutter_rust_bridge_codegen`, system build deps, and the **Flutter SDK** — then builds the wasm host. Idempotent (skips what's present); `--dry-run` previews the plan. |

### Templates

| Template | What you get |
|----------|--------------|
| `wgpu` | TypeScript on wgpu in a native window: a Game3D 3D scene + a Material-styled 2D HUD composited in one frame. |
| `flutter` | Flutter + `flutter_rust_bridge` + Elpa: a rich 2D UI in TypeScript, streamed to real Flutter widgets. |
| `wgpu-flutter` | The Flutter app above with a 3D `Native3DView` (Elpa's wgpu pipeline) inside the 2D UI. |

## The TypeScript → bytecode pipeline

Each template's app is **idiomatic, multi-file TypeScript** (one component per
file, `import`/`export` between them). `build` runs an embedded transpiler
(`transpile.rs`, built on **swc**) that:

1. **resolves** the relative-import graph from the entry file (bare/ambient
   imports — the vendored SDK — stay as runtime globals);
2. **strips** the types and runs a **shim** that lowers the idioms the Elpian VM
   lacks — template literals → `+`, `xs.map(f)` → `map(xs, f)`, `a.length` →
   `len(a)`, `Math.floor` → `floor`, `JSON.stringify` → `jsonStringify`, … —
   backed by a small runtime prelude (`src/runtime/prelude.js`) that supplies the
   higher-order array helpers in VM-subset JS;
3. **flattens** every module into one scope (the VM has no ES modules), prepends
   the vendored SDK, and compiles the result to bytecode via the Elpian VM.

The shim is what makes "write normal TypeScript" work against a VM whose stdlib
is global functions rather than methods. The SDK ships as plain VM-subset JS and
is linked ahead of the app; ambient `.d.ts` files give your editor the SDK types.

### Supported TypeScript

Classes (incl. getters), arrow functions, `for…of`, array/object/nested
destructuring, **default parameters**, block-scoped `let`/`const` (correctly
shadowed — the transpiler flattens block scoping for the VM), template literals,
`**`, ternaries, and a broad stdlib surface mapped to the VM's globals:

- **arrays** — `map filter reduce forEach find findIndex some every flat
  flatMap push pop shift unshift slice splice concat reverse sort sort(cmp)
  join indexOf lastIndexOf includes at fill`, `Array.isArray/from/of`
- **strings** — `toUpperCase toLowerCase trim split substring charAt charCodeAt
  replace replaceAll repeat startsWith endsWith padStart padEnd includes slice`
- **Math** — `floor ceil round trunc abs sign sqrt cbrt pow exp log log2 log10
  sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh atanh hypot min
  max random PI E`
- **Object/JSON/coercions** — `Object.keys/values/entries/assign`,
  `JSON.parse/stringify`, `Number String Boolean parseInt parseFloat`

### Not supported (the build reports a clean error)

The Elpian VM lacks the primitives these lower to (`arguments`, assignment- and
sequence-expressions, `fn.apply`), so they are intentionally rejected rather than
mis-compiled:

- spread (`[...a]`, `f(...a)`, `{...o}`) — use `concat(...)` / explicit args
- optional chaining (`a?.b`) — use `isNull(a) ? … : a.b`
- nullish coalescing (`a ?? b`) — use `isNull(a) ? b : a`
- rest parameters (`function f(...xs)`) — pass an array

`console.log` is a no-op (the sandbox has no stdout).

## Project manifest (`elpa.json`)

```json
{
  "name": "my_app",
  "template": "wgpu",
  "entry": "app/ts/main.ts",
  "sdk": ["app/sdk/game3d"],
  "outDir": "app/dist",
  "appOut": "assets/app/main.js"
}
```

`entry` is the TS bundler root; `sdk` lists the VM-subset SDK directories
prepended (lexically) ahead of the app; `outDir` receives `app.js` + `app.bc`.
`appOut` (Flutter only) additionally writes *prelude + app* where the Dart loader
concatenates it after the SDK modules.

## What gets generated

Every project vendors the five core Elpa crates (`elpa`, `elpian-vm`,
`elpa-protocol`, `elpa-renderer`, `elpa-runtime`) into an `engine/` Cargo
workspace, so it builds without the original repository. The Flutter templates
additionally copy the live Flutter bridge crate, the Dart shell, and the Elpa
SDK. Each generated project has its own `README.md` with the full walkthrough.

## How it's built

A Rust binary: `src/main.rs` dispatches the commands; `transpile.rs` is the
swc-based transpiler/bundler; `builder.rs`, `serve.rs`, `install.rs` and
`scaffold.rs` implement `build` / `dev` / `install` / `init`. The `templates/`
directory holds the per-project skeletons (TypeScript sources + host crate +
config, with `__APP_NAME__` / `__APP_SNAKE__` / `__APP_TITLE__` tokens); the live
engine, SDK and Flutter sources are copied from the repository at generation time.
