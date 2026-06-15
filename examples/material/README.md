# Elpa Material Design 3 framework (JavaScript)

A small **Flutter-style Material Design 3 UI framework** for Elpa — written in
**JavaScript**, not Rust. Elpa compiles it to its VM and runs it directly. The
SDK provides widget constructors, a layout engine, an animated theme, and a
component runtime; an app uses them as a black box and never touches the GPU.

| File | What it is |
|------|------------|
| [`assets/elpa-material.js`](assets/elpa-material.js) | **The SDK.** The rounded-rect SDF pipeline, the glyph font (now with digits + symbols), a vector icon set, the responsive layout coordinator, the M3 colors/sizes, ~50 widget constructors (layout, Material, content, charts, media), the platform-service wrappers (storage/clock/network), and the retained-tree component runtime (`defineComponent` / `runApp`, with per-component `update`) whose internals end in `gpu.submit`. |
| [`assets/demo.js`](assets/demo.js) | **The original app.** Declares state, composes a widget tree from the SDK's widgets (including custom components), and calls `runApp`. No `gpu.submit`, no glyphs, no coordinates. |
| [`assets/gallery.js`](assets/gallery.js) | **The widget gallery.** A second app that showcases the *extended* widget set across four bottom-nav sections (Layout · Widgets · Charts · Media), a navigation drawer, a modal dialog and a snackbar, plus the storage/clock/network wrappers. |
| `src/lib.rs` | Embeds the JS (`MODULE_JS`, `DEMO_JS`, `GALLERY_JS`) and links them with [`program`] / [`gallery_program`]. |
| `tests/run.rs` | Runs the original demo on a headless `Elpa` instance end to end — first paint, tap/key/wheel interaction, animation, resize — and validates the WGSL with `naga`. |
| `tests/gallery.rs` | Runs the gallery end to end: first paint, section switching, list scrolling, text input, modal overlays, the drawer animation, and a storage round-trip — all as **one** instanced draw over the same shader. |

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

* **Widgets are description objects.** Constructors just build them, exactly like
  Flutter `Widget`s. The catalog now spans five families (see below).
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

Edit the SDK in [`assets/elpa-material.js`](assets/elpa-material.js) and the apps
in [`assets/demo.js`](assets/demo.js) / [`assets/gallery.js`](assets/gallery.js)
— there is no generator step; the JS *is* the framework.

## Widget catalog

Everything below is built from the **one** rounded-rect SDF instance (16 floats:
center, half-size, corner radius, border, rotation, feather, fill rgba, border
rgba). Text is vector-stroke capsules; icons, charts, the pie's wedges and the
video chrome are all the same instance with different parameters. So the entire
catalog still renders as a **single instanced draw** over **one** shader — the
gallery test asserts exactly that.

* **Layout** — `Container` (color/border/radius/padding/size), `Padding`,
  `Center`, `Align`, `SizedBox`, `Spacer`, `Row`/`Column` (with `cross`
  alignment), `Expanded`/`Flexible` (flex distribution), `Stack` + `Positioned`,
  `Wrap`, `ListView` (scrollable, item-culled), `GridView` (scrollable),
  `Card`, `Scaffold` (now also `bottomBar`, `drawer`, `snackbar`, `dialog`).
* **Material** — `AppBar` (with `onMenu`/`onAction`), `Fab`, `FilledButton`,
  `OutlinedButton`, `IconButton`, `Icon` (vector set), `Avatar`, `Badge`,
  `Switch`, `Checkbox`, `Radio`, `Slider`, `Chip`, `Progress`,
  `CircularProgress`, `Divider`, `ListTile`, `TextField` (focus + caret +
  keyboard input), `Tabs`, `NavigationBar`, `SegmentedButton`, `ExpansionTile`,
  `Banner`, `Snackbar`, `Dialog` (modal scrim), `Drawer` (sliding, animated).
* **Content** — `Text` (now with digits/symbols and `headline`…`micro` sizes),
  `DataTable`.
* **Charts** — `BarChart`, `LineChart`, `PieChart` (radial-spoke fill, optional
  donut hole), `Sparkline`.
* **Media** — `Image` and `VideoPlayer` (full chrome: surface, play/pause,
  draggable scrubber, time). See the production-readiness note below for what
  "real" images/video need from the host.

## Platform services & production-readiness assessment

The task that produced the gallery asked whether Elpa's **network and storage**
are enough to make this a production app framework. The SDK exposes thin,
capability-gated wrappers over Elpa's `askHost` seam, and the answer is **yes for
data, with two clearly-scoped host gaps for pixels**:

| Capability | SDK API | Host backing (today) | Verdict |
|---|---|---|---|
| **Storage** | `storeRead/Write/Exists/List/Delete` | `fs.*` → `MemoryFileStore` (web/IndexedDB analog) **or** `NativeFileStore` (sandboxed disk), byte-capped | ✅ Production-ready. Same virtual FS on web, mobile, desktop; bounded; on by default. |
| **Network** | `httpGet/httpPost` | `net.fetch` → pluggable `NetProvider` (synchronous) | ✅ Sufficient for REST/JSON. Denied by default; the host grants a provider. The gallery degrades gracefully to "OFFLINE" when it isn't. |
| **Clock** | `now()` | `time.now`/`time.monotonic` | ✅ On by default. |
| **Randomness** | `randomUnit()` | `random.*` (SplitMix64) | ✅ Off by default; granted explicitly. |
| **Bitmap images** | `Image` widget | — (no texture-sampling pipeline yet) | ⚠️ Rendered as a styled placeholder surface. Needs a **textured pipeline + an image-decode/`writeTexture` host call**. |
| **Video** | `VideoPlayer` widget | — (no external-surface compositing) | ⚠️ Full controls render; frames are a placeholder. Needs an **external/video-surface composite** host call (platform player → GPU texture). |

Every service is gated by a `Capability` (and an `EnvToggles` switch) and
short-circuits to a typed null when unplugged, so the wrappers never trap — an
app can probe what the platform actually grants. **Net-net:** for data-driven,
cross-platform apps (the bulk of Flutter's surface — lists, forms, dashboards,
settings, charts fed by a REST API and cached to storage) the runtime is already
enough. The two gaps are both *additive host calls* on the existing
`elpa-protocol`/`HostEnv` seam — no change to the VM or the SDK's widget model —
which is the natural next step on the roadmap.

## Known limitations (Elpa JS front-end)

Extending the SDK surfaced a few rough edges in the **VM's JavaScript front-end**
(`crates/elpian-vm/src/sdk/compiler.rs`) that only appear once a *large* program
(this SDK plus an app) is compiled. They are codegen bugs, not language-design
limits, and each has a clean workaround the SDK/gallery already follow:

* **Returning a `push`-built local array** can yield `null`; build arrays with
  `concat` when you must `return` one (storing a `push`-built array in an object
  field and using it — the common `children: kids` case — is fine).
* **Very large / deeply-nested function bodies** can mis-compile object literals
  (manifesting as an "array used as object key" trap). Keep builders **small** —
  one widget or group per function — and assemble sections from calls. The
  gallery is structured exactly this way.
* **`let x; if (…) { x = … }` immediately before an object-literal call inside a
  loop body** can mis-align that object; compute such conditional values through
  a helper call instead (see `galCellRole` in `gallery.js`).

These are good candidates for a follow-up fix in the front-end; until then the
guidance above keeps SDK and app code on the supported path.
