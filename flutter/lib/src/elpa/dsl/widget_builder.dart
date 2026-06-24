/// The built-in vocabulary that maps Elpa DSL node types to real Flutter
/// widgets. Apps extend it with custom widgets via `flutter.define`
/// (see [ElpaWidgetRegistry.defineCustom]); these builtins cover the common
/// layout, content, and interaction primitives.
///
/// Every builder pulls children through [ElpaBuildScope.buildChildren] so the
/// caching/boundary machinery applies recursively, and routes gestures through
/// [ElpaBuildScope.dispatch] so taps/changes flow back to the app on
/// `flutter.event`.
library;

import 'package:flutter/material.dart';

import '../native/elpa_texture.dart';
import 'cache.dart';
import 'dsl_node.dart';

/// Build the registry of built-in node builders.
ElpaWidgetRegistry buildDefaultRegistry() {
  return ElpaWidgetRegistry(<String, ElpaNodeBuilder>{
    'Empty': (c, n, s) => const SizedBox.shrink(),
    'Fragment': (c, n, s) => _firstOrColumn(c, n, s),

    'Text': (c, n, s) => Text(
          n.propString('text'),
          textAlign: _textAlign(n.propString('align', 'start')),
          style: _textStyle(n.props['style']),
        ),

    'Column': (c, n, s) => Column(
          mainAxisAlignment: _mainAxis(n.propString('mainAxisAlignment', 'start')),
          crossAxisAlignment: _crossAxis(n.propString('crossAxisAlignment', 'center')),
          mainAxisSize: n.propBool('shrink') ? MainAxisSize.min : MainAxisSize.max,
          children: s.buildChildren(c, n),
        ),

    'Row': (c, n, s) => Row(
          mainAxisAlignment: _mainAxis(n.propString('mainAxisAlignment', 'start')),
          crossAxisAlignment: _crossAxis(n.propString('crossAxisAlignment', 'center')),
          mainAxisSize: n.propBool('shrink') ? MainAxisSize.min : MainAxisSize.max,
          children: s.buildChildren(c, n),
        ),

    'Stack': (c, n, s) => Stack(
          alignment: _alignment(n.propString('alignment', 'topStart')),
          children: s.buildChildren(c, n),
        ),

    'Center': (c, n, s) => Center(child: _onlyChild(c, n, s)),

    'Padding': (c, n, s) => Padding(
          padding: _insets(n.props['padding']),
          child: _onlyChild(c, n, s),
        ),

    'SizedBox': (c, n, s) => SizedBox(
          width: n.props['width'] == null ? null : n.propDouble('width'),
          height: n.props['height'] == null ? null : n.propDouble('height'),
          child: _onlyChild(c, n, s),
        ),

    'Container': (c, n, s) => Container(
          width: n.props['width'] == null ? null : n.propDouble('width'),
          height: n.props['height'] == null ? null : n.propDouble('height'),
          padding: n.props['padding'] == null ? null : _insets(n.props['padding']),
          margin: n.props['margin'] == null ? null : _insets(n.props['margin']),
          alignment: n.props['alignment'] == null ? null : _alignment(n.propString('alignment')),
          decoration: BoxDecoration(
            color: _color(n.props['color']),
            borderRadius: BorderRadius.circular(n.propDouble('radius')),
          ),
          child: _onlyChild(c, n, s),
        ),

    'Expanded': (c, n, s) => Expanded(
          flex: (n.props['flex'] as num?)?.toInt() ?? 1,
          child: _onlyChild(c, n, s),
        ),

    'Flexible': (c, n, s) => Flexible(
          flex: (n.props['flex'] as num?)?.toInt() ?? 1,
          child: _onlyChild(c, n, s),
        ),

    'Button': (c, n, s) => ElevatedButton(
          onPressed: _tap(n, s, 'onTap'),
          child: Text(n.propString('label', 'Button')),
        ),

    'IconButton': (c, n, s) => IconButton(
          onPressed: _tap(n, s, 'onTap'),
          icon: Icon(_icon(n.propString('icon', 'star'))),
        ),

    'GestureDetector': (c, n, s) => GestureDetector(
          onTap: _tap(n, s, 'onTap'),
          onDoubleTap: _tap(n, s, 'onDoubleTap'),
          onLongPress: _tap(n, s, 'onLongPress'),
          child: _onlyChild(c, n, s),
        ),

    'ListView': (c, n, s) {
      final children = s.buildChildren(c, n);
      return ListView.builder(
        scrollDirection:
            n.propString('axis', 'vertical') == 'horizontal' ? Axis.horizontal : Axis.vertical,
        padding: n.props['padding'] == null ? null : _insets(n.props['padding']),
        // itemBuilder keeps off-screen children lazy — the app streams a windowed
        // child list and Flutter only builds what is visible.
        itemCount: children.length,
        itemBuilder: (ctx, i) => children[i],
      );
    },

    'Scaffold': (c, n, s) => Scaffold(
          appBar: n.props['title'] == null
              ? null
              : AppBar(title: Text(n.propString('title'))),
          body: _childNamed(c, n, s, 'body') ?? _onlyChild(c, n, s),
          floatingActionButton: _childNamed(c, n, s, 'fab'),
        ),

    'Image': (c, n, s) => Image.network(
          n.propString('src'),
          fit: BoxFit.values.firstWhere(
            (f) => f.name == n.propString('fit', 'cover'),
            orElse: () => BoxFit.cover,
          ),
        ),

    // The native, wgpu-rendered Elpa widget: a zero-copy texture (or platform
    // view on web). Painted by Elpa's own renderer, composited inline by Flutter.
    'ElpaNative': (c, n, s) => ElpaNativeView(
          textureId: (n.props['textureId'] as num?)?.toInt(),
          canvasId: n.props['canvasId'] as String?,
          width: n.props['width'] == null ? null : n.propDouble('width'),
          height: n.props['height'] == null ? null : n.propDouble('height'),
        ),

    // Fallback for an unrecognized type: render nothing but stay alive so a later
    // `flutter.define` can supply the builder without crashing the tree.
    'Unknown': (c, n, s) => const SizedBox.shrink(),
  });
}

// ---- helpers ----------------------------------------------------------------

Widget _onlyChild(BuildContext c, DslNode n, ElpaBuildScope s) =>
    n.children.isEmpty ? const SizedBox.shrink() : s.build(c, n.children.first, 0);

Widget? _childNamed(BuildContext c, DslNode n, ElpaBuildScope s, String slot) {
  for (var i = 0; i < n.children.length; i++) {
    if (n.children[i].propString('slot') == slot) return s.build(c, n.children[i], i);
  }
  return null;
}

Widget _firstOrColumn(BuildContext c, DslNode n, ElpaBuildScope s) {
  final kids = s.buildChildren(c, n);
  if (kids.length == 1) return kids.first;
  return Column(mainAxisSize: MainAxisSize.min, children: kids);
}

VoidCallback? _tap(DslNode n, ElpaBuildScope s, String event) {
  final id = n.events[event];
  if (id == null) return null;
  return () => s.dispatch(id, {'event': event, 'key': n.key});
}

TextAlign _textAlign(String v) => switch (v) {
      'center' => TextAlign.center,
      'end' || 'right' => TextAlign.right,
      'justify' => TextAlign.justify,
      _ => TextAlign.left,
    };

TextStyle? _textStyle(Object? raw) {
  if (raw is! Map) return null;
  final m = raw.cast<String, Object?>();
  return TextStyle(
    fontSize: (m['size'] as num?)?.toDouble(),
    fontWeight: (m['bold'] as bool?) == true ? FontWeight.bold : null,
    color: _color(m['color']),
    fontStyle: (m['italic'] as bool?) == true ? FontStyle.italic : null,
  );
}

MainAxisAlignment _mainAxis(String v) => switch (v) {
      'center' => MainAxisAlignment.center,
      'end' => MainAxisAlignment.end,
      'spaceBetween' => MainAxisAlignment.spaceBetween,
      'spaceAround' => MainAxisAlignment.spaceAround,
      'spaceEvenly' => MainAxisAlignment.spaceEvenly,
      _ => MainAxisAlignment.start,
    };

CrossAxisAlignment _crossAxis(String v) => switch (v) {
      'start' => CrossAxisAlignment.start,
      'end' => CrossAxisAlignment.end,
      'stretch' => CrossAxisAlignment.stretch,
      _ => CrossAxisAlignment.center,
    };

Alignment _alignment(String v) => switch (v) {
      'center' => Alignment.center,
      'topStart' || 'topLeft' => Alignment.topLeft,
      'topCenter' => Alignment.topCenter,
      'topEnd' || 'topRight' => Alignment.topRight,
      'centerStart' || 'centerLeft' => Alignment.centerLeft,
      'centerEnd' || 'centerRight' => Alignment.centerRight,
      'bottomStart' || 'bottomLeft' => Alignment.bottomLeft,
      'bottomCenter' => Alignment.bottomCenter,
      'bottomEnd' || 'bottomRight' => Alignment.bottomRight,
      _ => Alignment.topLeft,
    };

EdgeInsets _insets(Object? raw) {
  if (raw is num) return EdgeInsets.all(raw.toDouble());
  if (raw is Map) {
    final m = raw.cast<String, Object?>();
    return EdgeInsets.only(
      left: (m['left'] as num?)?.toDouble() ?? 0,
      top: (m['top'] as num?)?.toDouble() ?? 0,
      right: (m['right'] as num?)?.toDouble() ?? 0,
      bottom: (m['bottom'] as num?)?.toDouble() ?? 0,
    );
  }
  return EdgeInsets.zero;
}

Color? _color(Object? raw) {
  if (raw is num) return Color(raw.toInt());
  if (raw is String && raw.startsWith('#')) {
    final hex = raw.substring(1);
    final value = int.tryParse(hex.length == 6 ? 'FF$hex' : hex, radix: 16);
    return value == null ? null : Color(value);
  }
  return null;
}

IconData _icon(String name) => switch (name) {
      'add' => Icons.add,
      'remove' => Icons.remove,
      'menu' => Icons.menu,
      'close' => Icons.close,
      'home' => Icons.home,
      'settings' => Icons.settings,
      'favorite' => Icons.favorite,
      _ => Icons.star,
    };
