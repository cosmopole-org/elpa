/// Native (desktop/mobile) surface provisioner: the zero-copy Flutter texture
/// path. A per-OS plugin allocates a shared GPU buffer, registers it with
/// Flutter's texture registry, and returns its texture id plus the raw OS handle;
/// Rust then imports that same buffer into wgpu, so Elpa renders the texture
/// Flutter samples with no copy.
///
/// The plugin lives in the project's platform runners and answers a
/// [MethodChannel]. Its `create` returns `{ textureId, handle, rowStride }` and
/// its `release` frees the buffer for a texture id. If no plugin is installed
/// (the channel throws `MissingPluginException`), provisioning fails gracefully
/// and the `Native3DView` stays a placeholder while the 2D UI runs.
library;

import 'package:flutter/services.dart';

import '../engine.dart';
import 'elpa_surface.dart';

/// Must match the channel name the native texture plugins register.
const MethodChannel _channel = MethodChannel('com.elpa/native_texture');

ElpaSurfaceProvisioner createPlatformProvisioner() => _NativeSurfaceProvisioner();

/// What the plugin handed back for a provisioned surface.
class _NativeHandle {
  _NativeHandle(this.textureId, this.rawHandle, this.rowStride);
  final int textureId;
  final int rawHandle;
  final int rowStride;
}

class _NativeSurfaceProvisioner implements ElpaSurfaceProvisioner {
  final Map<String, _NativeHandle> _handles = {};

  @override
  Future<ElpaSurfaceBinding> create(
    ElpaEngine engine,
    String viewKey,
    int widthPx,
    int heightPx,
    double dpr,
  ) async {
    try {
      final res = await _channel.invokeMapMethod<String, Object?>('create', {
        'width': widthPx,
        'height': heightPx,
      });
      if (res == null) return ElpaSurfaceBinding.none;
      final textureId = (res['textureId'] as num?)?.toInt();
      final rawHandle = (res['handle'] as num?)?.toInt();
      if (textureId == null || rawHandle == null) return ElpaSurfaceBinding.none;
      final rowStride = (res['rowStride'] as num?)?.toInt() ?? 0;
      _handles[viewKey] = _NativeHandle(textureId, rawHandle, rowStride);
      return ElpaSurfaceBinding(textureId: textureId);
    } on PlatformException {
      return ElpaSurfaceBinding.none;
    } on MissingPluginException {
      // No native texture plugin installed for this OS yet: run 2D-only.
      return ElpaSurfaceBinding.none;
    }
  }

  @override
  Future<bool> activate(ElpaEngine engine, String viewKey, int widthPx, int heightPx) async {
    final h = _handles[viewKey];
    if (h == null) return false;
    return engine.registerSurface(
      rawHandle: h.rawHandle,
      rowStride: h.rowStride,
      width: widthPx,
      height: heightPx,
    );
  }

  @override
  void release(ElpaEngine engine, String viewKey) {
    final h = _handles.remove(viewKey);
    if (h == null) return;
    // Fire-and-forget; the plugin frees the shared buffer + unregisters the id.
    _channel.invokeMethod<void>('release', {'textureId': h.textureId});
  }
}
