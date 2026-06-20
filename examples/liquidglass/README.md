# Elpa Liquid Glass UI kit (JavaScript)

A **Liquid Glass UI kit** for Elpa — Apple's iOS-26 *"Liquid Glass"* material —
written in **JavaScript**, not Rust. Elpa compiles it to its VM and runs it
directly. The SDK provides glass widget constructors, a layout engine, an animated
glass theme and a component runtime; an app uses them as a black box and never
touches the GPU.

The headline is the renderer: the kit draws the **entire** UI — a refractable
wallpaper, glass chrome, solids and text — through **one instanced pipeline** in
**two GPU passes**, *regardless of how many widgets are on screen*, so it stays
high-FPS.

## How the glass is rendered

Liquid Glass is a real optical material: translucent panels that **refract** the
content behind them, with **edge lensing**, **chromatic aberration** at the rim, a
soft **blur**, and a directional **specular** highlight. The kit computes that
formula per-fragment from a signed-distance field, the same way production WebGL
implementations do, and captures the actual backdrop so glass bends real content —
not a faked blur.

```text
                        the one instanced stream (20 floats/instance)
   widget tree ─▶ paint ─▶ [ wallpaper · glass lenses · solids · glyphs ]
                                 │
        ┌────────────────────────┴─────────────────────────────┐
   Pass A  CAPTURE                                       Pass B  SURFACE
   draw instances [0, firstGlass)                  draw the whole stream once
   into a ½-res offscreen "scene" texture          to the surface; each GLASS
   (the wallpaper + content behind chrome)         fragment samples the scene
                                                    texture with refraction +
                                                    chromatic aberration + blur
                                                    + specular + tint
```

Two draw calls per frame. The per-fragment glass math (`assets/sdk/00-data.js`,
`GLASS_WGSL`):

* **SDF coverage** — `sd_round_box(p, half, r)` decides inside/outside with
  anti-aliased coverage; one rounded-box primitive is every shape in the kit.
* **Surface normal** — the SDF gradient (central differences) is the glass
  surface normal `n`, pointing outward.
* **Refraction (edge lensing)** — the backdrop UV is displaced along `n` by
  `edge² · refraction`, where `edge` rises from 0 in the centre to 1 at the rim:
  a convex-lens magnification of what's just outside the panel.
* **Chromatic aberration** — the R and B channels are sampled at a slightly
  larger / smaller offset along `n`, only at the rim, for the prism fringe.
* **Blur** — a 5-tap box blur of the (already ½-res, pre-softened) backdrop.
* **Specular** — `pow(edge, 2.5) · max(dot(n, lightDir), 0)` lights the top-left
  rim; the opposite rim is darkened for depth.
* **Tint** — a translucent glass colour over the refracted backdrop, plus a faint
  inner rim line.

Every instance carries a `kind` (`SOLID` / `GLYPH` / `GLASS` / `SHADOW`) the
fragment shader branches on, so background gradients, glass, opaque accents and
text all ride **the same pipeline and the same two draws**.

## Architecture (object-oriented, single-responsibility modules)

The SDK is built from ES6 `class`es, concatenated in dependency order by `lib.rs`
(exactly like a Flutter app `import`s `package:flutter/material.dart`):

| File | What it is |
|------|------------|
| `assets/sdk/00-data.js` | The `GLASS_WGSL` shader, the glyph fallback font, accent palettes, constants and pure helpers. |
| `assets/sdk/10-engine.js` | `GlassPainter` (emits the 20-float instances + hit regions, with a transform/opacity stack), `GlassTheme` (vivid wallpaper, glass tints, specular rim, ink colours, accents, light↔dark cross-fade), `Metrics` (responsive window size classes), `FontEngine` (host atlas + stroke fallback), `IconEngine` (vector icons + SVG path stroker), `AnimationClock` (eased values + press layers with per-key subscribers). |
| `assets/sdk/20-widget.js` | The `Widget` base class: the measure / paint / compose / reassemble / bucket protocol. |
| `assets/sdk/30-widgets-layout.js` | Layout widgets: `Container`, `Padding`, `SafeArea`, `Center`/`Align`, `SizedBox`/`Spacer`, `Row`/`Column` (flex + alignment), `Expanded`, `Stack`/`Positioned`, `Wrap`, `ListView`/`GridView` (scroll, item-culled), `Scaffold`, `Badge`, plus the glass-panel / gradient painters. |
| `assets/sdk/31-widgets-glass.js` | The glass catalog: `GlassCard`, `AppBar`, `FilledButton`/`GlassButton`/`OutlinedButton`, `Fab`, `IconButton`, `Switch`, `Slider`, `Chip`, `SegmentedButton`, `NavigationBar`, `Tabs`, `TextField`, `ListTile`, `Divider`, `Avatar`, `Progress`/`CircularProgress`, `Dialog`, `BottomSheet`, `Text`, `Icon`, and the `Opacity`/`Transform` effect wrappers. |
| `assets/sdk/40-runtime.js` | `ComponentNode` + the `Glass` runtime: mount, partial update, the per-frame animation clock, the event loop, and the **two-pass `gpu.submit` frame builder**. |
| `assets/sdk/50-api.js` | The single `Glass` instance, the public widget constructors, `defineComponent`/`runApp`, the theme / responsive / font controls and the capability-gated platform-service wrappers. |
| `assets/demo.js` | The showcase app: a glass `Scaffold` (app bar, body of glass cards, a floating glass `NavigationBar`, an accent `Fab`, a `BottomSheet`) wired to state. |

## Writing an app

```js
let dark = 0.0; let vol = 0.4;
let App = defineComponent(function(props, update) {
    setTheme(dark, 0);
    return Scaffold({
        appBar: AppBar({ title: "LIQUID GLASS" }),
        fab: Fab({ accent: 1.0, onTap: () => { dark = 1.0 - dark; update(); } }),
        body: GlassCard({ child: Column({ gap: 3.0, children: [
            Text("VOLUME", { size: "caption", ink: "soft" }),
            Slider({ value: vol, onChanged: (v) => { vol = v; update(); } }),
            GlassButton({ label: "GLASS", onTap: () => { dark = 1.0 - dark; update(); } }),
        ] }) }),
    });
});
runApp(App);
```

* **Widgets are description objects** built by constructors, exactly like Flutter.
* **Components are `(props, update) => widget` functions** wrapped once with
  `defineComponent` and instantiated like any widget; `update()` re-runs **only
  that component** and reassembles the frame from every other component's cached
  output.
* **The app owns its state** as plain variables; a tap/`onChanged` closure mutates
  state and calls `update()`.

The whole UI is responsive (Material window size classes): a phone gets larger
type, ≥48dp touch targets, a floating glass nav bar and generous spacing; a wide
window keeps a denser, centred reading column.

## Performance

Because the frame is **two draw calls** no matter the widget count, and a scoped
`update()` re-runs just one component before reassembling cached output, the kit
is cheap to animate. The end-to-end benchmark (`tests/bench.rs`, headless, the VM
cost of mount + paint + the two-pass submit build) on the showcase demo:

| Workload | Cost | Headroom |
|---|---|---|
| Scoped widget ease (switch toggle) | **0.32 ms/frame** | ~3000 fps |
| Full-tree theme cross-fade | **2.5 ms/frame** | ~400 fps |
| Pointer-move repaint | 0.10 ms/event | — |

(841 instances/frame in the demo, of which the glass chrome is 11 lenses.) Run it:

```bash
cargo test -p elpa-liquidglass --release --test bench -- --ignored --nocapture
```

## Build & test

```bash
cargo test -p elpa-liquidglass            # e2e: WGSL validation + the runtime
cargo run  -p elpa-liquidglass --bin build_bytecode   # JS → VM bytecode (assets/demo.bc)
```

`tests/run.rs` drives the SDK + demo on a real (headless) `Elpa` instance end to
end — first paint, the two-pass capture+surface frame, the glass-lens instances,
tap/key interaction, animation and resize — and validates the WGSL with `naga`,
exactly as wgpu does.

## How it stays inside the supported JavaScript

The SDK and app are plain JavaScript that Elpa's in-VM front-end lowers to the
same Elpian AST a hand-written program would produce. It leans on the subset's
ES6 `class`es (engine services, the `Widget` hierarchy and the runtime, with
`constructor`, methods, `this`, single inheritance via `extends`/`super(...)`,
`new`), arrow functions / closures (tap callbacks, the component `update`),
`if`/`for`/`while`, objects, arrays, member assignment, and `askHost(api, args)`.
The SDK and app run in **one** VM, so `lib.rs` links the SDK ahead of the app.
