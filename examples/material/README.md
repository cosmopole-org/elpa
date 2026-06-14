# Elpa Material Design 3 UI kit (Elpian AST)

An **interactive Material Design 3 (expressive) UI-kit SDK** for Elpa programs —
and, like the engine [`examples/sdk`](../sdk), **the kit itself is Elpian AST**,
not Rust. It ships as JSON that runs directly on the Elpian VM and that any Elpa
program can pull in at runtime with `vm.import`.

| File | What it is |
|------|------------|
| [`assets/elpa-material.ast.json`](assets/elpa-material.ast.json) | **The UI kit.** An Elpian AST `program` whose body is a `gpu.define` per widget. Importable via `vm.import`. |
| [`assets/demo.ast.json`](assets/demo.ast.json) | A complete, **interactive** Elpian app: imports the kit, lays widgets out from `gpu.surfaceInfo`, and wires pointer / wheel / keyboard events to widget state. |
| `src/bin/build_material.rs` | The **generator** that authors the two JSON files. Not the SDK — just tooling. Run `cargo run -p elpa-material --bin build_material` to regenerate. |
| `src/lib.rs` | Only embeds the JSON (`MODULE_AST`, `DEMO_AST`) so host examples can bundle and register it. |
| `tests/run.rs` | Runs the JSON assets through a headless `Elpa` instance end to end — including real pointer/wheel/keyboard events — and validates the WGSL with `naga`. |

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
  `VOLUME`, the radio `A/B/C`, …) is drawn with the same primitive as a 5×7
  dot-matrix font. Because glyph geometry depends only on layout, it is computed
  once into a cached buffer (rebuilt on resize), so per-frame cost stays tiny.

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

## Why it fits inside the Elpian language

The Elpian VM has no `sin`/`cos`/`tan`, and its `bool*bool` is unreliable / its
`ifStmt` untested. So this kit obeys two rules:

* **All shape & anti-aliasing math lives in WGSL** — one rounded-rect *signed
  distance field* draws crisp pills, circles, cards, bars and (rotated) check
  marks. The Elpian side ships only resource objects, instanced draw definitions,
  and per-instance `f32` data.
* **All interaction is branch-free arithmetic.** Hit-tests are comparisons
  `cast` to `0.0`/`1.0` and AND-ed by multiplication; a toggle is
  `s + t - 2*s*t`, a select is `s*(1-h) + v*h`, a clamp is two `cast`-gated
  subtractions. The handler uses only the VM's well-exercised opcodes
  (`arithmetic`, `cast`, `functionCall`, `definition`, `assignment`, `indexer`,
  `host_call`) — no control flow.

The whole event model and per-frame layout therefore run as plain Elpian AST.

## How a program uses it

```text
program:
  vm.import("assets/elpa-material.ast.json")   // registers elpa.m3.{card,appBar,...}
  onEvent(e):  ...arithmetic state updates from e.{type,nx,ny,deltaY,key}...
  onFrame(dt): ...ease animations toward targets... ; render()
  render():    gpu.submit(frame)                // frame references widgets by id:
      renderPass:
        setBindGroup(0, globals)                // viewport uniform
        useDefinition("elpa.m3.card")           // host splices each widget's draw
        useDefinition("elpa.m3.switch")         //   and feeds it this frame's
        ...                                      //   computed instance buffer
```

## Live / regenerating

The [`examples/web`](../web) example loads this demo, so it is testable live on
GitHub Pages. To rebuild the assets:

```bash
cargo run -p elpa-material --bin build_material   # rewrites assets/*.ast.json
cargo test -p elpa-material                       # headless VM run + WGSL validation
```
