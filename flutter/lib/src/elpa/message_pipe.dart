/// The Dart half of the high-performance messaging pipe between the JavaScript
/// running on the Elpian VM and the Flutter app.
///
/// A [ElpaPipe] multiplexes the single flat message stream coming out of the
/// engine into per-channel broadcast streams, and offers a typed [send] back
/// into the VM. It is deliberately thin: messages carry **raw JSON text** and are
/// decoded by whoever subscribes, so a high-rate channel (e.g. `flutter.render`)
/// never pays for a decode it doesn't use.
library;

import 'dart:async';
import 'dart:convert';

import 'bridge.dart';

/// Routes outbound [ElpaMessage]s to per-channel listeners and sends inbound
/// messages back to the VM. One pipe per running engine.
class ElpaPipe {
  ElpaPipe(this._sendRaw);

  /// How the pipe delivers an inbound message to the VM. Supplied by the engine
  /// (it calls `bridge.post`). Returns the messages the VM emitted in response,
  /// which the engine feeds straight back into [ingest] — so a host → guest send
  /// that triggers a re-render lands on `flutter.render` with no extra round-trip.
  final Future<List<ElpaMessage>> Function(String channel, String payloadJson) _sendRaw;

  final Map<String, StreamController<ElpaMessage>> _channels = {};

  /// Subscribe to a channel. The returned stream is broadcast, so multiple
  /// widgets can observe the same channel (e.g. the shell on `flutter.render`
  /// and a debug overlay on the same channel).
  Stream<ElpaMessage> on(String channel) =>
      _channels.putIfAbsent(channel, () => StreamController<ElpaMessage>.broadcast()).stream;

  /// Send a structured value to the VM on [channel]. Encodes once here; the VM
  /// receives it as `onHostMessage({channel, message})`.
  Future<void> send(String channel, Object? message) =>
      sendRaw(channel, jsonEncode(message));

  /// Send pre-encoded JSON text to the VM (skips a re-encode for payloads the
  /// caller already has as text). The emitted reply messages are re-ingested.
  Future<void> sendRaw(String channel, String payloadJson) async {
    final emitted = await _sendRaw(channel, payloadJson);
    ingest(emitted);
  }

  /// Fan a batch of freshly-emitted messages out to their channel listeners.
  /// Called by the engine after every drive turn.
  void ingest(List<ElpaMessage> messages) {
    for (final m in messages) {
      final controller = _channels[m.channel];
      if (controller != null && controller.hasListener) {
        controller.add(m);
      }
    }
  }

  /// Close all channel controllers.
  Future<void> close() async {
    for (final c in _channels.values) {
      await c.close();
    }
    _channels.clear();
  }
}
