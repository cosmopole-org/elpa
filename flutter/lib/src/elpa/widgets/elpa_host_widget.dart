/// [ElpaApp] — the one widget an embedder drops into its tree to run an Elpa
/// program as a Flutter UI.
///
/// It boots an [ElpaEngine] from JavaScript source (or bytecode) using the
/// provided [ElpaBridge], shows a builder-supplied placeholder while the VM
/// compiles, then hands off to [ElpaShell]. It owns the engine lifecycle and
/// disposes it with the widget.
library;

import 'package:flutter/material.dart';

import '../bridge.dart';
import '../elpa_shell.dart';
import '../engine.dart';

class ElpaApp extends StatefulWidget {
  const ElpaApp({
    super.key,
    required this.bridge,
    required this.jsSource,
    this.initialWidth = 1080,
    this.initialHeight = 1920,
    this.initialScale = 1.0,
    this.loading,
    this.onError,
  });

  final ElpaBridge bridge;

  /// The Elpa app, as JavaScript source. (Use [ElpaEngine.bootFromBytecode] via a
  /// custom host for the shipped bytecode path.)
  final String jsSource;

  final int initialWidth;
  final int initialHeight;
  final double initialScale;

  /// Shown while the engine boots. Defaults to a centered spinner.
  final WidgetBuilder? loading;

  /// Shown if the source fails to compile. Defaults to a centered message.
  final Widget Function(BuildContext, Object error)? onError;

  @override
  State<ElpaApp> createState() => _ElpaAppState();
}

class _ElpaAppState extends State<ElpaApp> {
  late Future<ElpaEngine?> _boot;

  @override
  void initState() {
    super.initState();
    _boot = ElpaEngine.bootFromJs(
      widget.bridge,
      jsSource: widget.jsSource,
      width: widget.initialWidth,
      height: widget.initialHeight,
      scale: widget.initialScale,
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<ElpaEngine?>(
      future: _boot,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return widget.loading?.call(context) ??
              const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return widget.onError?.call(context, snap.error!) ??
              Center(child: Text('Elpa failed to start: ${snap.error}'));
        }
        final engine = snap.data;
        if (engine == null) {
          const err = 'Elpa app failed to compile (unsupported JS).';
          return widget.onError?.call(context, err) ?? const Center(child: Text(err));
        }
        return _EngineHost(engine: engine);
      },
    );
  }
}

/// Holds the booted engine and disposes it when removed, hosting the shell.
class _EngineHost extends StatefulWidget {
  const _EngineHost({required this.engine});
  final ElpaEngine engine;

  @override
  State<_EngineHost> createState() => _EngineHostState();
}

class _EngineHostState extends State<_EngineHost> {
  @override
  Widget build(BuildContext context) => ElpaShell(engine: widget.engine);

  @override
  void dispose() {
    widget.engine.dispose();
    super.dispose();
  }
}
