/// [ElpaEngineScope] — makes the running [ElpaEngine] available to descendant
/// widgets (notably [ElpaNativeView], which needs it to provision its GPU
/// surface). The shell installs one above the built DSL tree.
library;

import 'package:flutter/widgets.dart';

import 'engine.dart';

class ElpaEngineScope extends InheritedWidget {
  const ElpaEngineScope({super.key, required this.engine, required super.child});

  final ElpaEngine engine;

  static ElpaEngine? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ElpaEngineScope>()?.engine;

  @override
  bool updateShouldNotify(ElpaEngineScope oldWidget) => !identical(engine, oldWidget.engine);
}
