/// [ElpaEngine] — the Dart-side owner of one running Elpa app.
///
/// It binds an [ElpaBridge] handle to an [ElpaPipe], drives the VM's lifecycle
/// (start / input / frame / resize), and routes every batch of emitted messages
/// into the pipe so the UI layer reacts to them. This is the seam the Flutter
/// widgets talk to; they never touch the bridge directly.
library;

import 'dart:async';

import 'bridge.dart';
import 'message_pipe.dart';

/// A running Elpa application: its native handle, its reserved channels, and the
/// message pipe carrying its UI stream.
class ElpaEngine {
  ElpaEngine._(this._bridge, this.handle, this.channels) {
    pipe = ElpaPipe((channel, payload) => _bridge.post(handle, channel, payload));
  }

  final ElpaBridge _bridge;

  /// The native engine handle.
  final int handle;

  /// The reserved channel names, read from native at creation.
  final ElpaChannels channels;

  /// The multiplexed message pipe (per-channel streams + send-to-VM).
  late final ElpaPipe pipe;

  bool _disposed = false;

  /// Boot an app from JavaScript source. Returns `null` if it fails to compile.
  static Future<ElpaEngine?> bootFromJs(
    ElpaBridge bridge, {
    required String jsSource,
    required int width,
    required int height,
    required double scale,
  }) async {
    final handle = await bridge.createFromJs(jsSource, width, height, scale);
    if (handle == null) return null;
    final channels = await bridge.channels();
    return ElpaEngine._(bridge, handle, channels);
  }

  /// Boot an app from prebuilt VM bytecode.
  static Future<ElpaEngine?> bootFromBytecode(
    ElpaBridge bridge, {
    required List<int> bytecode,
    required int width,
    required int height,
    required double scale,
  }) async {
    final handle = await bridge.createFromBytecode(bytecode, width, height, scale);
    if (handle == null) return null;
    final channels = await bridge.channels();
    return ElpaEngine._(bridge, handle, channels);
  }

  /// Run the top-level program and route its initial render into the pipe.
  Future<void> start() async => pipe.ingest(await _bridge.start(handle));

  /// Forward a pointer event (logical coordinates).
  Future<void> pointer(ElpaPointerPhase phase, double x, double y, {int button = 0}) async =>
      pipe.ingest(await _bridge.pointer(handle, phase, x, y, button));

  /// Forward a scroll/wheel event.
  Future<void> wheel(double x, double y, double deltaY) async =>
      pipe.ingest(await _bridge.wheel(handle, x, y, deltaY));

  /// Forward a key event.
  Future<void> key(bool down, String key) async =>
      pipe.ingest(await _bridge.key(handle, down, key));

  /// Advance one animation tick.
  Future<void> frame(double dtMs) async => pipe.ingest(await _bridge.frame(handle, dtMs));

  /// Report a surface resize (physical pixels + DPR).
  Future<void> resize(int width, int height, double scale) async =>
      pipe.ingest(await _bridge.resize(handle, width, height, scale));

  /// Report updated safe-area insets (physical pixels).
  Future<void> safeArea(double top, double right, double bottom, double left) async =>
      pipe.ingest(await _bridge.safeArea(handle, top, right, bottom, left));

  /// Send a structured message into the app on an application channel.
  Future<void> send(String channel, Object? message) => pipe.send(channel, message);

  /// Drain diagnostic log lines.
  Future<List<String>> takeLog() => _bridge.takeLog(handle);

  /// Tear down the engine and its pipe.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await pipe.close();
    await _bridge.dispose(handle);
  }
}
