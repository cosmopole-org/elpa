/// Fallback surface provisioner: no GPU surface. Used on any target that is
/// neither web nor native-io (and as the conditional-import default). The
/// `Native3DView` stays a sized placeholder and the 2D UI runs as normal.
library;

import '../engine.dart';
import 'elpa_surface.dart';

ElpaSurfaceProvisioner createPlatformProvisioner() => const _NoSurfaceProvisioner();

class _NoSurfaceProvisioner implements ElpaSurfaceProvisioner {
  const _NoSurfaceProvisioner();

  @override
  Future<ElpaSurfaceBinding> create(
    ElpaEngine engine,
    String viewKey,
    int widthPx,
    int heightPx,
    double dpr,
  ) async =>
      ElpaSurfaceBinding.none;

  @override
  Future<bool> activate(ElpaEngine engine, String viewKey, int widthPx, int heightPx) async =>
      false;

  @override
  void release(ElpaEngine engine, String viewKey) {}
}
