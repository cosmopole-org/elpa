/// [ElpaNativeView] — the Flutter widget that composites Elpa's own wgpu output
/// inline, with no CPU copy of pixels.
///
/// Two compositing strategies, picked from what the platform provisioned (see
/// `elpa_surface.dart` and `rust/src/render.rs`):
///
/// * **[textureId]** (mobile/desktop) — Flutter's [Texture] widget samples an
///   externally-owned GPU texture by id. Elpa renders into the GPU buffer that
///   backs that id; Flutter composites it on the raster thread. The pixels live
///   on the GPU the whole time — this is the zero-copy path.
/// * **[canvasId]** (web) — Elpa's wgpu canvas is hosted as a platform view via
///   [HtmlElementView]; the Flutter web compositor layers it directly.
///
/// The view **self-provisions**: a `Native3DView` placed by the app carries no
/// surface, so on first layout this widget asks the [ElpaSurfaceProvisioner] for
/// one (sized to its box × DPR), upgrades the engine to a live wgpu backend, and
/// composites the result. Until then — and on any platform without a surface — it
/// is a sized placeholder, so layout is stable and the 2D UI keeps running. An
/// explicit [textureId]/[canvasId] (e.g. a manually managed surface) bypasses
/// provisioning and is composited as-is.
library;

import 'package:flutter/widgets.dart';

import '../elpa_engine_scope.dart';
import '../engine.dart';
import 'elpa_surface.dart';

class ElpaNativeView extends StatefulWidget {
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
  State<ElpaNativeView> createState() => _ElpaNativeViewState();
}

class _ElpaNativeViewState extends State<ElpaNativeView> {
  // One provisioner per app run, shared across views; it keys surfaces by view.
  static final ElpaSurfaceProvisioner _provisioner = createSurfaceProvisioner();

  ElpaSurfaceBinding _binding = ElpaSurfaceBinding.none;
  bool _provisioning = false;
  int _lastWidthPx = 0;
  int _lastHeightPx = 0;

  /// Cached so [dispose] (where an inherited lookup is illegal) can release.
  ElpaEngine? _engine;

  String get _viewKey => widget.key?.toString() ?? 'elpa.native.default';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _engine = ElpaEngineScope.maybeOf(context);
  }

  @override
  void dispose() {
    final engine = _engine;
    if (engine != null) _provisioner.release(engine, _viewKey);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // An explicitly-supplied surface (manual control / back-compat) wins.
    if (widget.textureId != null || widget.canvasId != null) {
      return _composite(ElpaSurfaceBinding(textureId: widget.textureId, canvasId: widget.canvasId));
    }

    final engine = ElpaEngineScope.maybeOf(context);
    final dpr = MediaQuery.maybeOf(context)?.devicePixelRatio ?? 1.0;

    return LayoutBuilder(
      builder: (context, constraints) {
        final logicalW = constraints.maxWidth.isFinite ? constraints.maxWidth : (widget.width ?? 0);
        final logicalH =
            constraints.maxHeight.isFinite ? constraints.maxHeight : (widget.height ?? 0);
        final wPx = (logicalW * dpr).round();
        final hPx = (logicalH * dpr).round();

        if (engine != null && !_provisioning && !_binding.isLive && wPx > 0 && hPx > 0) {
          _provisioning = true;
          _lastWidthPx = wPx;
          _lastHeightPx = hPx;
          // Provision after this frame so we don't mutate state during build.
          WidgetsBinding.instance.addPostFrameCallback((_) => _provision(engine, wPx, hPx, dpr));
        }
        return _composite(_binding);
      },
    );
  }

  Future<void> _provision(ElpaEngine engine, int wPx, int hPx, double dpr) async {
    final binding = await _provisioner.create(engine, _viewKey, wPx, hPx, dpr);
    if (!mounted) return;
    if (!binding.isLive) {
      _provisioning = false; // allow a retry on the next layout pass
      return;
    }
    setState(() => _binding = binding);
    // Let the compositing widget (Texture / HtmlElementView) mount, then start
    // GPU rendering into it — on web the canvas must be in the DOM first.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await _provisioner.activate(engine, _viewKey, _lastWidthPx, _lastHeightPx);
    });
  }

  Widget _composite(ElpaSurfaceBinding binding) {
    final Widget surface;
    if (binding.textureId != null) {
      // freeze: false lets the compositor pull new GPU frames every vsync without
      // Flutter rebuilding the widget tree — Elpa's render loop drives the pixels.
      surface = Texture(textureId: binding.textureId!, freeze: false);
    } else if (binding.canvasId != null) {
      surface = HtmlElementView(viewType: binding.canvasId!);
    } else {
      // No surface yet: take up the space so layout stays stable until one binds.
      surface = const SizedBox.expand();
    }
    if (widget.width == null && widget.height == null) return surface;
    return SizedBox(width: widget.width, height: widget.height, child: surface);
  }
}
