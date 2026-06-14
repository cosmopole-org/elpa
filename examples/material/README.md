# Elpa Material Design 3 UI kit (JavaScript)

An **interactive Material Design 3 (Material You) UI-kit SDK** for Elpa programs —
and, like the engine [`examples/sdk`](../sdk), **the kit itself is the app code**,
not Rust. It ships as **JavaScript** that Elpa compiles and runs directly on its
VM, and that any Elpa program can pull in at runtime with `vm.import`. An Elpa
instance is built straight from this source: `Elpa::new_from_js(backend, surface,
DEMO_JS)`.

| File | What it is |
|------|------------|
| [`assets/elpa-material.js`](assets/elpa-material.js) | **The UI kit.** A JS program whose top-level body registers one `gpu.define` per widget via `askHost`. Importable via `vm.import`. |
| [`assets/demo.js`](assets/demo.js) | A complete, **interactive** Elpa app in JS: imports the kit, lays widgets out from `gpu.surfaceInfo`, and wires pointer / wheel / keyboard events to widget state. |
| `src/lib.rs` | Only embeds the JS (`MODULE_JS`, `DEMO_JS`) so host examples can bundle and register it. |
| `tests/run.rs` | Builds the JS through a headless `Elpa` instance end to end — including real pointer/wheel/keyboard events — and validates the WGSL with `naga`. |

## Widgets

`card`, `appBar`, `filledButton`, `outlinedButton`, `fab` (floating action
button), `switch`, `checkbox`, `radioGroup` (3 radios), `slider`, `chip`,
`progress` (linear), `divider` and `labels` — every one drawn by **a single
shared rounded-rectangle SDF pipeline** (M3 shapes are rounded rects, pills and
circles). A widget definition is just an instanced draw of its rounded-rect
"layers" from a per-widget instance buffer the app fills each frame.

Two extras keep it looking like M3:

* **Elevation shadows.** The SDF carries a per-instance *feather* (edge
  softness); cards, the filled button and the FAB draw a soft, offset dark
  rounded rect behind them for a real drop shadow.
* **Captions.** There is no glyph engine, so text (`THEME`, `RESET`, `WI-FI`,
  `VOLUME`, the radio `A/B/C`, …) is drawn as a **vector stroke font**: each glyph
  is a few line segments rendered as rounded *capsules* (rotated rounded rects
  with fully-rounded ends, on the same primitive as every widget). Capsule ends
  overlap at joints, so strokes connect into smooth, continuous letterforms.
  Because glyph geometry depends only on layout, it is computed once into a cached
  buffer (rebuilt on resize), so per-frame cost stays tiny.

## Interaction (all event kinds, all wired in the VM)

| Event | What it does |
|-------|--------------|
| `pointerdown` | press buttons / FAB, toggle switch · checkbox · chip, select a radio, start a slider drag, cycle the FAB accent color |
| `pointermove` | drag the slider thumb; drive hover "state layers" on buttons / FAB |
| `pointerup` | release press states; end the slider drag |
| `wheel` | nudge the slider value |
| `keydown` | ◀ / ▶ nudge the slider · `d` toggles dark mode · space toggles the switch · `r` resets all controls |
| `keyup` | release the "key held" indicator |

Toggling the switch, checkbox and chip fills the linear progress bar; the FAB
cycles the whole palette's accent color; `d` (or the filled button) cross-fades
the entire UI between light and dark. Every change **animates** — thumbs slide,
check marks scale in, colors ease — via `onFrame`.

## How it stays inside the supported JavaScript

The kit is plain JavaScript, compiled by Elpa's in-VM front-end to the same
Elpian AST a hand-written program would produce. It obeys one structural rule and
one stylistic one:

* **All shape & anti-aliasing math lives in WGSL** — one rounded-rect *signed
  distance field* draws crisp pills, circles, cards, bars and (rotated) check
  marks. The JS side ships only resource objects, instanced draws, and
  per-instance `f32` data; it never does trigonometry on shapes.
* **Everything else is ordinary JS** — `function`s, `if`/`for`, objects, arrays,
  arithmetic, member access, and `askHost(api, [args])` host calls. Hit-tests are
  `if` comparisons, a toggle is `x = 1 - x`, animations ease with
  `cur + (target - cur) * k`. Boolean operators (`&&`/`||`), arrow functions and
  ternaries are *not* in the supported subset, so conditions nest plain `if`s.

The whole event model and per-frame layout run as that JavaScript.

## How a program uses it

```text
askHost("vm.import", ["assets/elpa-material.js"]);  // registers elpa.m3.{card,appBar,...}
function onEvent(e) {  /* state updates from e.{type,nx,ny,deltaY,key} */ render(); }
function onFrame(dt) { /* ease animations toward targets */ render(); }
function render() {                                 // frame references widgets by id:
  askHost("gpu.submit", [{ resources: [...], commands: [{ op: "renderPass",
    commands: [
      { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.globalsBind" },
      { cmd: "useDefinition", definition: "elpa.m3.card" },   // host splices each
      { cmd: "useDefinition", definition: "elpa.m3.switch" }, //   widget's draw and
      // ...                                                  //   feeds its buffer
    ] }] }]);
}
```

## Live / testing

The [`examples/web`](../web) example loads this demo, so it is testable live on
GitHub Pages. To exercise it headlessly:

```bash
cargo test -p elpa-material                       # headless VM run + WGSL validation
```

Edit the kit and demo directly in [`assets/elpa-material.js`](assets/elpa-material.js)
and [`assets/demo.js`](assets/demo.js) — there is no generator step; the JS *is*
the SDK.
