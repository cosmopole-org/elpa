/// [ElpaNativeView] — the Flutter widget that composites Elpa's own wgpu output
/// inline, with no CPU copy of pixels.
///
/// Two compositing strategies, picked from what the native side registered (see
/// `rust/src/render.rs`):
///
/// * **[textureId]** (mobile/desktop) — Flutter's [Texture] widget samples an
///   externally-owned GPU texture by id. Elpa renders into the GPU buffer that
///   backs that id; Flutter composites it on the raster thread. The pixels live
///   on the GPU the whole time — this is the zero-copy path.
/// * **[canvasId]** (web) — Elpa's wgpu canvas is hosted as a platform view via
///   [HtmlElementView]; the Flutter web compositor layers it directly.
///
/// The widget is otherwise an ordinary leaf: size it with a parent constraint or
/// the optional [width]/[height], and pointer events on top of it are forwarded
/// by the surrounding shell just like any other region.
library;

import 'package:flutter/widgets.dart';

class ElpaNativeView extends StatelessWidget {
  const ElpaNativeView({
    super.key,
    this.textureId,
    this.canvasId,
    this.width,
    this.height,
  });

  /// Flutter external-texture id (zero-copy GPU path) when non-null.
  final int? textureId;

  /// Web platform-view canvas selector when non-null.
  final String? canvasId;

  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context) {
    final Widget surface;
    if (textureId != null) {
      // freeze: false lets the compositor pull new GPU frames every vsync without
      // Flutter rebuilding the widget tree — Elpa's render loop drives the pixels.
      surface = Texture(textureId: textureId!, freeze: false);
    } else if (canvasId != null) {
      // Registered by the web bootstrap (platformViewRegistry.registerViewFactory).
      surface = HtmlElementView(viewType: canvasId!);
    } else {
      // No native surface yet (e.g. a headless/DSL-only build): take up the space
      // so layout is stable until the GPU surface is registered.
      surface = const SizedBox.expand();
    }
    if (width == null && height == null) return surface;
    return SizedBox(width: width, height: height, child: surface);
  }
}
