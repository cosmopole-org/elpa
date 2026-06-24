/// The Dart-facing contract for the native Elpa engine.
///
/// The rest of the app (the message pipe, the DSL interpreter, the shell)
/// depends only on this interface, never on the flutter_rust_bridge-generated
/// symbols directly. That keeps the UI layer analyzable and unit-testable
/// (a fake bridge stands in for the engine in tests) and isolates the one place
/// that touches generated code — [RustElpaBridge] in `bridge_rust.dart`.
library;

import 'package:meta/meta.dart';

/// One message crossing the pipe. [payload] is **raw JSON text**; decode it once
/// at the edge that needs the structured value (the DSL decoder, an app handler).
@immutable
class ElpaMessage {
  const ElpaMessage(this.channel, this.payload);

  /// Application/reserved channel selector (e.g. `flutter.render`).
  final String channel;

  /// The message value as raw JSON text.
  final String payload;

  @override
  String toString() => 'ElpaMessage($channel, ${payload.length} bytes)';
}

/// Pointer phase, mirroring the Rust `FfiPointer`.
enum ElpaPointerPhase { down, move, up }

/// The reserved channel names of the Elpa ⇄ Flutter contract. Sourced from Rust
/// at startup ([ElpaBridge] exposes them) so the two halves never drift.
@immutable
class ElpaChannels {
  const ElpaChannels({
    required this.render,
    required this.patch,
    required this.invalidate,
    required this.define,
    required this.event,
  });

  final String render;
  final String patch;
  final String invalidate;
  final String define;
  final String event;
}

/// The operations the native engine exposes. Every drive call returns the
/// messages the app emitted *during that turn*, so the pipe is pull-based and
/// allocation-light: there is no background polling and a payload string is
/// moved straight from the VM to Dart.
abstract interface class ElpaBridge {
  /// Read the reserved channel names from the native side.
  Future<ElpaChannels> channels();

  /// Compile an app from JavaScript source and return its handle, or `null` if
  /// the source is outside the supported subset.
  Future<int?> createFromJs(String jsSource, int width, int height, double scale);

  /// Compile an app from prebuilt VM bytecode (the shipped path).
  Future<int?> createFromBytecode(List<int> bytecode, int width, int height, double scale);

  /// Run the app's top-level program; returns its initial messages.
  Future<List<ElpaMessage>> start(int handle);

  /// Dispose of the engine for [handle].
  Future<void> dispose(int handle);

  /// Drive an input/lifecycle turn; each returns the messages emitted.
  Future<List<ElpaMessage>> pointer(
      int handle, ElpaPointerPhase phase, double x, double y, int button);
  Future<List<ElpaMessage>> wheel(int handle, double x, double y, double deltaY);
  Future<List<ElpaMessage>> key(int handle, bool down, String key);
  Future<List<ElpaMessage>> frame(int handle, double dtMs);
  Future<List<ElpaMessage>> resize(int handle, int width, int height, double scale);
  Future<List<ElpaMessage>> safeArea(
      int handle, double top, double right, double bottom, double left);

  /// Deliver a custom message into the app (host → guest) on any [channel].
  Future<List<ElpaMessage>> post(int handle, String channel, String payloadJson);

  /// Drain diagnostic log lines.
  Future<List<String>> takeLog(int handle);
}
