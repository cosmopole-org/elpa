/// [ElpaShell] — the Flutter widget that *is* the Elpa UI layer.
///
/// It owns the bridge between a running [ElpaEngine] and the real Flutter tree:
///
/// * subscribes to the engine's DSL channels (`flutter.render`, `flutter.patch`,
///   `flutter.invalidate`, `flutter.define`) and keeps the current [DslNode] tree;
/// * builds that tree through the caching/boundary machinery so unchanged
///   branches are neither rebuilt nor repainted;
/// * forwards raw pointer/scroll/key events to the VM's `onEvent` and semantic
///   widget events (taps, changes) to the app on `flutter.event`;
/// * reports surface size and safe-area insets so the app can lay out responsively;
/// * ticks animation frames **only while the app asks** (`flutter.tick`), so an
///   idle UI costs nothing per vsync.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'bridge.dart';
import 'dsl/cache.dart';
import 'dsl/dsl_node.dart';
import 'dsl/widget_builder.dart';
import 'engine.dart';

/// Channel the shell listens on (Dart-side only) for the app to request/stop the
/// animation ticker. Payload: `{ "on": true|false }`.
const String _tickChannel = 'flutter.tick';

class ElpaShell extends StatefulWidget {
  const ElpaShell({super.key, required this.engine});

  final ElpaEngine engine;

  @override
  State<ElpaShell> createState() => _ElpaShellState();
}

class _ElpaShellState extends State<ElpaShell> with SingleTickerProviderStateMixin {
  late final ElpaWidgetRegistry _registry;
  late final WidgetCache _cache;
  late final ScopeRegistry _scopes;
  late final ElpaBuildScope _scope;
  late final Ticker _ticker;
  final _subs = <StreamSubscription<dynamic>>[];

  DslNode? _root;
  Size? _lastSize;
  double _lastDpr = 1;
  Duration _lastTick = Duration.zero;

  ElpaEngine get _engine => widget.engine;

  @override
  void initState() {
    super.initState();
    _registry = buildDefaultRegistry();
    _cache = WidgetCache();
    _scopes = ScopeRegistry();
    _scope = ElpaBuildScope(
      registry: _registry,
      cache: _cache,
      scopes: _scopes,
      dispatch: _dispatchEvent,
    );
    _ticker = createTicker(_onTick);

    final ch = _engine.channels;
    _listen(ch.render, _onRender);
    _listen(ch.patch, _onPatch);
    _listen(ch.invalidate, _onInvalidate);
    _listen(ch.define, _onDefine);
    _listen(_tickChannel, _onTickRequest);

    // Subscribe first, then run the program so the initial render is delivered.
    _engine.start();
  }

  void _listen(String channel, void Function(Map<String, Object?>) handler) {
    final sub = _engine.pipe.on(channel).listen((msg) {
      final decoded = jsonDecode(msg.payload);
      if (decoded is Map) handler(decoded.cast<String, Object?>());
    });
    _subs.add(sub);
  }

  // ---- Channel handlers ------------------------------------------------------

  void _onRender(Map<String, Object?> json) {
    setState(() => _root = DslNode.fromJson(json));
  }

  void _onPatch(Map<String, Object?> json) {
    // A patch replaces the subtree identified by `key` with `node`. When that key
    // is a mounted render scope, the update is routed straight to *its* State —
    // only that scope rebuilds and repaints; the shell does not `setState`. The
    // root model is mirrored (no rebuild) so a later full render stays coherent
    // and never clobbers the in-place update.
    final key = json['key'] as String?;
    final nodeJson = json['node'];
    if (key == null || _root == null || nodeJson is! Map) return;
    final replacement = DslNode.fromJson(nodeJson.cast<String, Object?>());

    if (_scopes.update(key, replacement)) {
      _root = _replaceByKey(_root!, key, replacement);
      return;
    }

    // No scope mounted for this key: fall back to a full-tree rebuild.
    setState(() {
      _cache.invalidate(key);
      _root = _replaceByKey(_root!, key, replacement);
    });
  }

  void _onInvalidate(Map<String, Object?> json) {
    final key = json['key'] as String?;
    if (key == null) return;
    _cache.invalidate(key);
    // Prefer an isolated scope rebuild; only fall back to a shell rebuild if no
    // scope owns the key.
    if (!_scopes.invalidate(key)) {
      setState(() {});
    }
  }

  void _onDefine(Map<String, Object?> json) {
    final name = json['name'] as String?;
    final template = json['template'];
    if (name == null || template is! Map) return;
    _registry.defineCustom(name, DslNode.fromJson(template.cast<String, Object?>()));
    // A new definition may change how existing nodes render: drop their memos.
    setState(_cache.clear);
  }

  void _onTickRequest(Map<String, Object?> json) {
    final on = (json['on'] as bool?) ?? false;
    if (on && !_ticker.isActive) {
      _lastTick = Duration.zero;
      _ticker.start();
    } else if (!on && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _onTick(Duration elapsed) {
    final dtMs = _lastTick == Duration.zero
        ? 16.0
        : (elapsed - _lastTick).inMicroseconds / 1000.0;
    _lastTick = elapsed;
    _engine.frame(dtMs);
  }

  // ---- Event forwarding ------------------------------------------------------

  void _dispatchEvent(String handlerId, Map<String, Object?> payload) {
    _engine.send(_engine.channels.event, {'handler': handlerId, ...payload});
  }

  void _onPointerDown(PointerDownEvent e) =>
      _engine.pointer(ElpaPointerPhase.down, e.localPosition.dx, e.localPosition.dy,
          button: e.buttons);
  void _onPointerMove(PointerMoveEvent e) =>
      _engine.pointer(ElpaPointerPhase.move, e.localPosition.dx, e.localPosition.dy);
  void _onPointerUp(PointerUpEvent e) =>
      _engine.pointer(ElpaPointerPhase.up, e.localPosition.dx, e.localPosition.dy);
  void _onSignal(PointerSignalEvent e) {
    if (e is PointerScrollEvent) {
      _engine.wheel(e.localPosition.dx, e.localPosition.dy, e.scrollDelta.dy);
    }
  }

  // ---- Build -----------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    _syncSurface(context);

    final root = _root;
    final content = root == null
        ? const Center(child: CircularProgressIndicator())
        : _scope.build(context, root, 0);

    // Listener delivers raw pointer/scroll events to the VM (the low-level event
    // pipe); widget gestures (Button taps) ride the semantic `flutter.event`
    // channel via [_dispatchEvent]. Both layers coexist.
    return Listener(
      onPointerDown: _onPointerDown,
      onPointerMove: _onPointerMove,
      onPointerUp: _onPointerUp,
      onPointerSignal: _onSignal,
      behavior: HitTestBehavior.translucent,
      child: content,
    );
  }

  /// Push the current physical size + DPR + safe-area insets to the engine when
  /// they change (rotation, window resize, keyboard, system bars).
  void _syncSurface(BuildContext context) {
    final mq = MediaQuery.of(context);
    final size = mq.size;
    final dpr = mq.devicePixelRatio;
    if (size != _lastSize || dpr != _lastDpr) {
      _lastSize = size;
      _lastDpr = dpr;
      final w = (size.width * dpr).round();
      final h = (size.height * dpr).round();
      _engine.resize(w, h, dpr);
      final p = mq.padding;
      _engine.safeArea(p.top * dpr, p.right * dpr, p.bottom * dpr, p.left * dpr);
    }
  }

  // ---- Tree surgery ----------------------------------------------------------

  /// Return a copy of [tree] with the node whose key == [key] replaced by
  /// [replacement]. Structural sharing keeps unchanged branches identical, so
  /// their cached widgets continue to be reused.
  DslNode _replaceByKey(DslNode tree, String key, DslNode replacement) {
    if (tree.key == key) return replacement;
    if (tree.children.isEmpty) return tree;
    var changed = false;
    final newChildren = <DslNode>[];
    for (final child in tree.children) {
      final nc = _replaceByKey(child, key, replacement);
      if (!identical(nc, child)) changed = true;
      newChildren.add(nc);
    }
    if (!changed) return tree;
    return DslNode(
      type: tree.type,
      key: tree.key,
      rev: tree.rev,
      boundary: tree.boundary,
      props: tree.props,
      events: tree.events,
      children: newChildren,
    );
  }

  @override
  void dispose() {
    _ticker.dispose();
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}
