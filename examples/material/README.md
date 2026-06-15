# Elpa Material Design 3 framework (JavaScript)

A small **Flutter-style Material Design 3 UI framework** for Elpa — written in
**JavaScript**, not Rust. Elpa compiles it to its VM and runs it directly. The
SDK provides widget constructors, a layout engine, an animated theme, and a
component runtime; an app uses them as a black box and never touches the GPU.

| File | What it is |
|------|------------|
| [`assets/elpa-material.js`](assets/elpa-material.js) | **The SDK.** The rounded-rect SDF pipeline, the glyph font, the responsive layout coordinator, the M3 colors/sizes, the widget constructors, and the retained-tree component runtime (`defineComponent` / `runApp`, with per-component `update`) whose internals end in `gpu.submit`. |
| [`assets/demo.js`](assets/demo.js) | **The app.** Declares state, composes a widget tree from the SDK's widgets (including custom components), and calls `runApp`. No `gpu.submit`, no glyphs, no coordinates. |
| `src/lib.rs` | Embeds the JS (`MODULE_JS`, `DEMO_JS`) and links them with [`program`]. |
| `tests/run.rs` | Runs the linked program on a headless `Elpa` instance end to end — first paint, tap/key/wheel interaction, animation, resize — and validates the WGSL with `naga`. |

## Writing an app

```js
let count = 0; let sw = 0.0;

// A custom widget is a plain function `(props, update) => widget`, wrapped once
// with `defineComponent(...)` to become a widget constructor. Instantiate it in
// the tree like a Flutter widget — `Counter({ ... })`, no wrapper — and the
// runtime owns its identity, so its `update` repaints only it.
let Counter = defineComponent(function(props, update) {
    return Row({ gap: 4.0, children: [
        FilledButton({ label: "TAP", onTap: () => { count = count + 1; update(); } }),
        Switch({ id: "wifi", value: sw, onTap: () => { sw = 1.0 - sw; update(); } }),
    ] });
});

let App = defineComponent(function(props, update) {
    return Scaffold({
        appBar: AppBar({ title: "ELPA UI" }),
        fab: Fab({ onTap: () => { count = count + 1; update(); } }),
        body: Card({ child: Counter({}) }),
    });
});
runApp(App);
```

* **Widgets are description objects.** Constructors — `Scaffold`, `AppBar`,
  `Card`, `Column`, `Row`, `Text`, `FilledButton`, `OutlinedButton`, `Fab`,
  `Switch`, `Checkbox`, `Radio`, `Slider`, `Chip`, `Progress`, `Divider` — just
  build them, exactly like Flutter `Widget`s.
* **Components are plain functions** `(props, update) => widget`, wrapped once
  with `defineComponent(fn)` into a widget constructor (the Flutter
  `StatelessWidget` / `StatefulWidget` analog). Instantiate them in the tree like
  any built-in widget — `Tile({ ... })`, no `Component(...)` wrapper — so custom
  widgets nest exactly like the built-ins (see `Tile` and `RadioRow`).
* **`update()` repaints only its component.** The runtime re-runs *just that
  component's* function, repaints its subtree in place, and reassembles the frame
  from every other component's cached output — parents and siblings are not
  re-run. So you scope rebuilds by where you put state: the radios live in their
  own `RadioRow`, so selecting one repaints only the radios; app-wide state
  (theme, accent) lives in the root, whose `update` repaints everything.
* **The app owns its state** as plain variables; a tap/`onChanged`/`onKey`
  closure mutates state and calls `update()`. Tap callbacks are real arrow
  closures — the radios build one per `idx` in a loop.

## How the runtime works

The SDK keeps a **retained component tree**. A full render mounts it (running
every component function), then `_measure` computes intrinsic sizes and `_paint`
lays children out (a real Column/Row/Card layout pass), emits rounded-rect
instances + hit regions, and **caches each node's output**. `_submit` packs the
instance list into **one** instanced wgpu draw over the shared SDF pipeline and
`gpu.submit`s it.

When a component's `update()` fires, only that component's function re-runs and
its subtree is repainted at its cached box; each ancestor's output is then
**reassembled by concatenating cached children** (no function re-runs, no sibling
repaints) up to the root, which is re-submitted.

The animation clock is partial too. While painting, each component records which
animation keys it reads (eased values, press layers). On every frame the SDK
advances the animations and repaints **only the components whose keys are still
moving** — a toggle eases just its tile and the progress bar, not the rest — then
reassembles. The light/dark cross-fade is the one global case (it recolors
everything, so it re-emits the whole tree, but without re-running any component
function). Idle frames (nothing moving) skip everything, so the renderer's
partial-render cache keeps the GPU idle too.

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
