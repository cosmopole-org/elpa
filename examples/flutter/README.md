# elpa-flutter

A **faithful, layered port of Flutter** for Elpa, written as **JavaScript** and
run directly on the Elpa VM. Where the sibling [`material`](../material) kit
fuses measure + paint into one `Widget` pass, this SDK mirrors Flutter's *actual*
architecture, built bottom-to-top as separate layers:

| Layer | Module | Flutter analog |
|-------|--------|----------------|
| Raster backend | `assets/sdk/10-engine.js` | Skia / CanvasKit (`Painter`, glyph atlas) |
| `dart:ui` | `assets/sdk/20-ui.js` | `Offset`, `Size`, `Rect`, `RRect`, `Color`, `Paint`, `Gradient`, `Path`, `Canvas` |
| rendering | `assets/sdk/30-rendering.js` | `BoxConstraints`, `RenderObject`/`RenderBox`, `PaintingContext`, `RenderView`, `RenderFlex`, … |
| widgets | `assets/sdk/40-widget.js` | `Widget`/`Element`/`BuildContext`/`BuildOwner`, reconciliation, `StatelessWidget`/`StatefulWidget` |
| catalog | `assets/sdk/50-widgets.js` | the widget catalog + a small Material catalog |
| binding | `assets/sdk/60-binding.js` | `WidgetsFlutterBinding` + `runApp` (build→layout→paint→submit) |

The constraints flow **down**, sizes flow **up**, and the parent positions each
child — exactly the box layout protocol of `package:flutter/rendering`. The
widget tree inflates into an element tree that reconciles on rebuild
(`Widget.canUpdate` by runtime type + `Key`), and `setState` marks an element
dirty for the `BuildOwner` to rebuild in `buildScope`.

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
