/// Web surface provisioner: host Elpa's wgpu output on an HTML `<canvas>` that
/// Flutter composites as a platform view (`HtmlElementView`).
///
/// Two phases (see [ElpaSurfaceProvisioner]): [create] makes the canvas, registers
/// it as a platform-view factory, and returns its view-type so the tree can mount
/// an `HtmlElementView` for it. Only once that view is mounted is the canvas in
/// the DOM — so [activate] (which asks Rust to build a wgpu surface from the
/// canvas, looked up by id) must run after the first frame. The element id and the
/// platform-view type are the same string, which is how the Rust side finds it.
library;

import 'dart:ui_web' as ui_web;

import 'package:web/web.dart' as web;

import '../engine.dart';
import 'elpa_surface.dart';

ElpaSurfaceProvisioner createPlatformProvisioner() => _WebSurfaceProvisioner();

class _WebSurfaceProvisioner implements ElpaSurfaceProvisioner {
  final Map<String, web.HTMLCanvasElement> _canvases = {};
  int _seq = 0;

  @override
  Future<ElpaSurfaceBinding> create(
    ElpaEngine engine,
    String viewKey,
    int widthPx,
    int heightPx,
    double dpr,
  ) async {
    // A stable, unique id per view: it is both the element id (Rust looks the
    // canvas up by it) and the platform-view type Flutter mounts.
    final viewType = 'elpa-native-${engine.handle}-${viewKey.hashCode}-${_seq++}';

    final canvas = (web.document.createElement('canvas') as web.HTMLCanvasElement)
      ..id = viewType
      // Backing store in physical pixels for crisp HiDPI rendering…
      ..width = widthPx < 1 ? 1 : widthPx
      ..height = heightPx < 1 ? 1 : heightPx;
    // …and a CSS box that fills the platform-view slot Flutter lays out.
    canvas.style
      ..setProperty('width', '100%')
      ..setProperty('height', '100%')
      ..setProperty('display', 'block')
      ..setProperty('touch-action', 'none');
    _canvases[viewKey] = canvas;

    // The factory hands Flutter the very element we will render into.
    ui_web.platformViewRegistry.registerViewFactory(viewType, (int _) => canvas);

    return ElpaSurfaceBinding(canvasId: viewType);
  }

  @override
  Future<bool> activate(ElpaEngine engine, String viewKey, int widthPx, int heightPx) async {
    final canvas = _canvases[viewKey];
    if (canvas == null) return false;
    // Keep the backing store sized to the latest physical size before binding.
    canvas
      ..width = widthPx < 1 ? 1 : widthPx
      ..height = heightPx < 1 ? 1 : heightPx;
    return engine.registerSurface(canvasId: canvas.id, width: widthPx, height: heightPx);
  }

  @override
  void release(ElpaEngine engine, String viewKey) {
    final canvas = _canvases.remove(viewKey);
    canvas?.remove();
  }
}
