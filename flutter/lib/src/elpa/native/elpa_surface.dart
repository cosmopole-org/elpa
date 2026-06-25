/// Provisioning of the GPU surface that backs an [ElpaNativeView] — the bridge
/// between a `Native3DView` in the widget tree and Elpa's wgpu output.
///
/// A `Native3DView` placed by the app carries no surface of its own: the *shell*
/// provisions one for it and upgrades the engine to a live wgpu backend. How that
/// surface is sourced is platform-specific, so the implementation is selected by
/// conditional import:
///
/// * **web** (`elpa_surface_web.dart`) — create a `<canvas>`, register it as a
///   platform view, and point a wgpu surface at it (`HtmlElementView`).
/// * **native** (`elpa_surface_io.dart`) — ask the per-OS texture plugin to
///   allocate a shared GPU buffer + register it with Flutter's texture registry,
///   then import it zero-copy into wgpu (`Texture`).
/// * **fallback** (`elpa_surface_stub.dart`) — no surface; the view stays a sized
///   placeholder (the 2D UI still runs).
///
/// Provisioning is two-phase so it composes with how each platform mounts a
/// surface: [ElpaSurfaceProvisioner.create] yields the compositing binding (the
/// texture id / canvas view-type) to put in the tree *now*; once that widget is
/// mounted, [ElpaSurfaceProvisioner.activate] tells the engine to start rendering
/// into it. On web this ordering matters — the canvas only joins the DOM when the
/// `HtmlElementView` mounts, and the wgpu surface can only bind to it after that.
library;

import '../engine.dart';
import 'elpa_surface_stub.dart'
    if (dart.library.js_interop) 'elpa_surface_web.dart'
    if (dart.library.io) 'elpa_surface_io.dart';

/// How a provisioned surface is composited into the Flutter tree.
class ElpaSurfaceBinding {
  const ElpaSurfaceBinding({this.textureId, this.canvasId});

  /// A Flutter external-texture id (native zero-copy path) → `Texture`.
  final int? textureId;

  /// A platform-view view-type for the wgpu canvas (web) → `HtmlElementView`.
  final String? canvasId;

  bool get isLive => textureId != null || canvasId != null;

  /// No surface available (provisioning failed, or a headless/unsupported build).
  static const ElpaSurfaceBinding none = ElpaSurfaceBinding();
}

/// Provisions (and releases) the GPU surface for a single `Native3DView`, keyed by
/// the view's stable key so a rebuild reuses the same surface. Selected per
/// platform by conditional import; see this file's doc comment.
abstract interface class ElpaSurfaceProvisioner {
  /// Allocate the surface and return how to composite it. Does **not** yet start
  /// GPU rendering — call [activate] once the returned binding is mounted.
  /// `widthPx`/`heightPx` are physical pixels (logical × dpr).
  Future<ElpaSurfaceBinding> create(
    ElpaEngine engine,
    String viewKey,
    int widthPx,
    int heightPx,
    double dpr,
  );

  /// Upgrade the engine to render into the surface created for [viewKey]. Returns
  /// whether a live GPU backend is now installed. Safe to call after the
  /// compositing widget from [create] has mounted.
  Future<bool> activate(ElpaEngine engine, String viewKey, int widthPx, int heightPx);

  /// Release any resources held for [viewKey] (canvas element, shared texture).
  void release(ElpaEngine engine, String viewKey);
}

/// The platform surface provisioner (web canvas, native shared texture, or the
/// no-op stub), chosen at compile time by the conditional import above.
ElpaSurfaceProvisioner createSurfaceProvisioner() => createPlatformProvisioner();
