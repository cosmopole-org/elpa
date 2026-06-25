# elpa-flutter

A **faithful, layered port of Flutter** for Elpa, written as **JavaScript** and
run directly on the Elpa VM. Where the sibling [`material`](../material) kit
fuses measure + paint into one `Widget` pass, this SDK mirrors Flutter's *actual*
architecture, built bottom-to-top as separate layers:

| Layer | Module | Flutter analog |
|-------|--------|----------------|
| Raster backend | `assets/sdk/10-engine.js` | Skia / CanvasKit (`Painter`, glyph atlas, `Ticker`) |
| `dart:ui` | `assets/sdk/20-ui.js` | `Offset`, `Size`, `Rect`, `RRect`, `Color`, `Paint`, `Gradient`, `Path`, `Canvas` (incl. real `clipRect`/`clipRRect`) |
| rendering | `assets/sdk/30-rendering.js` | `BoxConstraints`, `RenderObject`/`RenderBox`, `PaintingContext`, `RenderView`, `RenderFlex`, `RenderStack`, `RenderClip*`, … |
| widgets | `assets/sdk/40-widget.js` | `Widget`/`Element`/`BuildContext`/`BuildOwner`, reconciliation, `StatelessWidget`/`StatefulWidget`, `InheritedWidget`, `ParentDataWidget` |
| animation | `assets/sdk/45-animation.js` | `SchedulerBinding`, `Curves`, `AnimationController`, `Tween`/`ColorTween`, `CurvedAnimation`, `AnimatedBuilder`, `TweenAnimationBuilder`, the explicit transitions (`Fade`/`Scale`/`Rotation`/`Slide`/`Size`) and the implicitly-animated widgets (`AnimatedContainer`/`Opacity`/`Align`/`Padding`/`Scale`/`Rotation`/`Positioned`) |
| catalog | `assets/sdk/50-widgets.js` | `SizedBox`, `Container`, `Padding`, `Center`, `Align`, `Row`/`Column`, `Expanded`, `Spacer`, `Stack`, `Positioned`, `Text`, `Opacity`, `Transform`, `ClipRect`/`ClipRRect`/`ClipOval`, `AspectRatio`, `FractionallySizedBox`, `FittedBox`, `LimitedBox`, `Wrap`, `Divider`, `IgnorePointer`, `GestureDetector`, … |
| scrolling | `assets/sdk/52-scroll.js` | `Scrollable`, `ScrollController`/`ScrollPosition`, drag + friction **fling** physics, `ListView`(+`.builder`), `GridView`(+`.builder`), `SingleChildScrollView` — viewports that **clip + cull** off-screen children |
| Material | `assets/sdk/55-material.js` | `Theme`/`ThemeData`, `MaterialApp`, `Scaffold` (Drawer + FAB + bottom nav), `AppBar`, `Card`, `ListTile`, `ElevatedButton`/`TextButton`/`OutlinedButton`/`IconButton`/`FloatingActionButton`, `Switch`/`Checkbox`/`Radio`/`Slider`, `LinearProgressIndicator`/`CircularProgressIndicator`, `Chip`, `CircleAvatar`, `Drawer`, `BottomNavigationBar`, a sliding `TabBar`, `Icon` (30+ glyphs), `CustomPaint` |
| binding | `assets/sdk/60-binding.js` | `WidgetsFlutterBinding` + `runApp` (build→layout→paint→submit), the per-frame scheduler that ticks `AnimationController`s on real dt, and pointer hit-test routing |

The constraints flow **down**, sizes flow **up**, and the parent positions each
child — exactly the box layout protocol of `package:flutter/rendering`. The
widget tree inflates into an element tree that reconciles on rebuild
(`Widget.canUpdate` by runtime type + `Key`), and `setState` marks an element
dirty for the `BuildOwner` to rebuild in `buildScope`.

## Animation & scrolling

`AnimationController`s are ticked by a `SchedulerBinding` with the **real elapsed
frame dt** (so motion is frame-rate independent), and a controller's listeners
mark just their element dirty → the `BuildOwner` rebuilds that subtree → one
cheap partial frame, exactly like Flutter. `Curves` are solved from cubic-bezier
control points (plus the physical bounce/elastic curves). Scrolling is real
drag-then-**fling** physics: a `ScrollPosition` clamps the offset to the content
extent and a friction simulation decays the release velocity each frame; the
viewport render objects **clip** to their bounds (a Vello clip layer — a pushed
rounded-rect the scene composites within) and **cull** children outside the
viewport, so a long `ListView` repaints only its visible rows.

## The demo: *Elpa Sound*

`assets/demo.js` is a realistic multi-screen Material app — a `MaterialApp` with
a live light/dark theme, a `Scaffold` (slide-in `Drawer`, `FloatingActionButton`,
`BottomNavigationBar`) and four independently-scrolled screens: a **Discover**
feed (gradient hero, an animated `Sparkline`, `Chip` `Wrap`, trending `Card`s), a
scrollable **Browse** `GridView`, a 40-row **Library** `ListView.builder`, and a
**Settings** screen wiring `Switch`/`Slider`/`Radio`/`Checkbox`, a sliding
`TabBar`, and a counter.

> **Rendering.** The kit paints through the **Vello scene** path: the `Painter`
> records a batch of high-level vector ops — fills, strokes, and clip/blend
> layers — which the host rasterizes with Vello via `scene.submit` (the scene
> renderer skips re-presenting an unchanged frame). Direct wgpu is no longer the
> drawing mechanism; it survives as the `rawWgpu` scene op, which this 2D kit does
> not need. An animation frame rebuilds only the dirty subtree and scroll
> viewports cull to the visible rows, so the per-frame op count stays bounded.

## Build & test

```bash
cargo test -p elpa-flutter
# (re)compile the demo to VM bytecode for the web/native hosts:
cargo run -p elpa-flutter --bin build_bytecode
```

The test suite lowers the SDK's WGSL and validates it with `naga`, then runs the
SDK + demo through a headless `Elpa` instance and asserts the frame is built and
submitted — and, as the layers land, that the constraint/layout/reconciliation
behaviour matches Flutter.
