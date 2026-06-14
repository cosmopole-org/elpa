# Elpa Material Design 3 framework (JavaScript)

A small **Flutter-style Material Design 3 UI framework** for Elpa — written in
**JavaScript**, not Rust. Elpa compiles it to its VM and runs it directly. The
SDK provides widget constructors, a layout engine, an animated theme, and a
component runtime; an app uses them as a black box and never touches the GPU.

| File | What it is |
|------|------------|
| [`assets/elpa-material.js`](assets/elpa-material.js) | **The SDK.** The rounded-rect SDF pipeline, the glyph font, the responsive layout coordinator, the M3 colors/sizes, the widget constructors, and the component runtime (`createComponent` / `runApp`) whose internals end in `gpu.submit`. |
| [`assets/demo.js`](assets/demo.js) | **The app.** Declares state, composes a widget tree from the SDK's widgets (including custom components), and calls `runApp`. No `gpu.submit`, no glyphs, no coordinates. |
| `src/lib.rs` | Embeds the JS (`MODULE_JS`, `DEMO_JS`) and links them with [`program`]. |
| `tests/run.rs` | Runs the linked program on a headless `Elpa` instance end to end — first paint, tap/key/wheel interaction, animation, resize — and validates the WGSL with `naga`. |

## Writing an app

```js
let count = 0;
let app = createComponent((update) => Scaffold({
    appBar: AppBar({ title: "ELPA UI" }),
    fab: Fab({ onTap: () => { count = count + 1; update(); } }),
    body: Card({ child: Column({ gap: 3.0, children: [
        FilledButton({ label: "TAP", onTap: () => { count = count + 1; update(); } }),
        Switch({ id: "wifi", value: sw, onTap: () => { sw = 1.0 - sw; update(); } }),
    ] }) }),
}));
runApp(app);
```

* **Widgets are description objects.** Constructors — `Scaffold`, `AppBar`,
  `Card`, `Column`, `Row`, `Text`, `FilledButton`, `OutlinedButton`, `Fab`,
  `Switch`, `Checkbox`, `Radio`, `Slider`, `Chip`, `Progress`, `Divider` — just
  build them, exactly like Flutter `Widget`s.
* **`createComponent(builder)` makes a stateful widget** from a closure
  `(update) => subtree`. Calling `update()` re-runs the app and re-submits its
  graphics — the only `setState` you need. Build your own widgets by composing
  others inside a component (see `Tile` and `RadioRow` in the demo).
* **The app owns its state** as plain variables; a tap/`onChanged`/`onKey`
  closure mutates state and calls `update()`. Tap callbacks are real arrow
  closures — the radios build one per `idx` in a loop.

## How the runtime works

Each frame the SDK walks the widget tree: `_build` expands components, `_measure`
computes intrinsic sizes, and `_paint` lays children out (a real Column/Row/Card
layout pass) and emits rounded-rect instances + hit regions. `_submit` packs the
instance list into **one** instanced wgpu draw over the shared SDF pipeline and
`gpu.submit`s it. Idle frames (nothing animating) skip the rebuild entirely, so
the partial-render cache keeps the GPU idle too.

Every shape — cards, pill buttons, the rounded-square FAB, the M3 switch
(outlined off-state, growing thumb), checkboxes, radios, the slider, chips,
progress, and even the vector-stroke text — is the **same** rounded-rect signed
distance field, fed 16 floats per instance. All M3 color roles (a
surface-container hierarchy, outline variants, the tonal accent palette the FAB
cycles) and the animated light/dark theme live in the SDK.

## How it stays inside the supported JavaScript

The SDK and app are plain JavaScript that Elpa's in-VM front-end lowers to the
same Elpian AST a hand-written program would produce. It leans on the subset's
**arrow functions / closures** (tap callbacks, the component `update`, function
values stored in widget fields and invoked as `widget.onTap()`), `if`/`for`,
objects, arrays, member assignment, and `askHost(api, [args])`. The SDK and the
app run in **one** VM — Elpa's `vm.import` runs a module in a separate, disposed
VM, so its functions would not be callable; [`program`] therefore links the SDK
ahead of the app, like `import 'package:flutter/material.dart'`.

## Live / testing

The [`examples/web`](../web) example runs this app, so it is testable live on
GitHub Pages. Headless:

```bash
cargo test -p elpa-material    # full program through a real VM + WGSL validation
```

Edit the SDK in [`assets/elpa-material.js`](assets/elpa-material.js) and the app
in [`assets/demo.js`](assets/demo.js) — there is no generator step; the JS *is*
the framework.
