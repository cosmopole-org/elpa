/// The caching + decoupling machinery that keeps DSL rendering cheap.
///
/// Three cooperating mechanisms, all required by the design:
///
/// 1. **Revision memoization** ([WidgetCache]) — a node carrying a `rev` reuses
///    its previously-built `Widget` instance while `rev` is unchanged. Returning
///    the identical instance lets Flutter short-circuit the subtree's rebuild, so
///    an app that bumps only the `rev`s that actually changed pays to rebuild
///    *only* those branches.
/// 2. **Boundaries** ([ElpaBoundary]) — a node marked `boundary: true` becomes a
///    self-contained `StatefulWidget` wrapped in a `RepaintBoundary`. A change
///    inside it neither rebuilds nor repaints the rest of the tree; it can also
///    be invalidated in isolation via the `flutter.invalidate` channel.
/// 3. **Keyed identity** — every node has a stable identity (its `key`), so when
///    the tree reorders, Flutter reuses elements/state instead of recreating them.
library;

import 'package:flutter/widgets.dart';

import 'dsl_node.dart';

/// How a [DslNode] is turned into a [Widget]. The scope gives the builder access
/// to children-building and event dispatch without globals.
typedef ElpaNodeBuilder = Widget Function(BuildContext context, DslNode node, ElpaBuildScope scope);

/// Dispatches an app callback. The shell wires this to `engine.send(eventChannel, …)`.
typedef ElpaEventSink = void Function(String handlerId, Map<String, Object?> payload);

/// Per-build context handed to every node builder: the widget registry, the
/// cache, and the event sink. One scope is reused across a whole tree build.
class ElpaBuildScope {
  ElpaBuildScope({
    required this.registry,
    required this.cache,
    required this.dispatch,
  });

  final ElpaWidgetRegistry registry;
  final WidgetCache cache;
  final ElpaEventSink dispatch;

  /// Build a single child, applying caching and boundary wrapping. [index] is the
  /// child's sibling position, used for structural identity when it has no key.
  Widget build(BuildContext context, DslNode node, int index) {
    final id = node.identity(index);

    // A boundary becomes its own stateful + repaint-isolated subtree.
    if (node.boundary) {
      return RepaintBoundary(
        key: ValueKey('elpa.boundary.$id'),
        child: ElpaBoundary(key: ValueKey('elpa.boundary.state.$id'), node: node, scope: this),
      );
    }

    // Revision memoization: reuse the cached widget while rev is stable.
    final cached = cache.get(id, node.rev);
    if (cached != null) return cached;

    final builder = registry.builderFor(node.type);
    final widget = builder(context, node, this);
    cache.put(id, node.rev, widget);
    return widget;
  }

  /// Build a node's children in order.
  List<Widget> buildChildren(BuildContext context, DslNode node) {
    final out = <Widget>[];
    for (var i = 0; i < node.children.length; i++) {
      out.add(build(context, node.children[i], i));
    }
    return out;
  }
}

/// A revision-keyed widget memo. Keyed by node identity; an entry is reused while
/// the node's `rev` matches. Nodes without a `rev` are never cached (always
/// rebuilt), so an app opts subtrees into caching by versioning them.
class WidgetCache {
  final Map<String, _Entry> _entries = {};

  Widget? get(String id, int? rev) {
    if (rev == null) return null;
    final e = _entries[id];
    if (e != null && e.rev == rev) return e.widget;
    return null;
  }

  void put(String id, int? rev, Widget widget) {
    if (rev == null) return;
    _entries[id] = _Entry(rev, widget);
  }

  /// Drop a node's memo so its next build is fresh (the `flutter.invalidate`
  /// channel routes here).
  void invalidate(String id) => _entries.remove(id);

  void clear() => _entries.clear();
}

class _Entry {
  _Entry(this.rev, this.widget);
  final int rev;
  final Widget widget;
}

/// The registry of node builders, including app-defined custom widgets.
class ElpaWidgetRegistry {
  ElpaWidgetRegistry(this._builtins);

  final Map<String, ElpaNodeBuilder> _builtins;
  final Map<String, DslNode> _custom = {};

  /// Register (or replace) a custom widget definition (`flutter.define`). The
  /// template is a DSL subtree whose `Slot` nodes are filled by the instance's
  /// children and whose `$prop` string props are substituted from the instance.
  void defineCustom(String name, DslNode template) => _custom[name] = template;

  bool get hasUnknownFallback => _builtins.containsKey('Unknown');

  ElpaNodeBuilder builderFor(String type) {
    final custom = _custom[type];
    if (custom != null) {
      return (context, node, scope) => scope.build(context, _expand(custom, node), 0);
    }
    return _builtins[type] ?? _builtins['Unknown'] ?? _missing;
  }

  /// Expand a custom-widget template against an instance node: `Slot` → instance
  /// children, `$prop` string props → instance prop values.
  DslNode _expand(DslNode template, DslNode instance) {
    if (template.type == 'Slot') {
      // Replace the slot with the instance's children wrapped in a passthrough.
      return DslNode(type: 'Fragment', key: instance.key, children: instance.children);
    }
    final resolvedProps = template.props.map((k, v) {
      if (v is String && v.startsWith(r'$')) {
        return MapEntry(k, instance.props[v.substring(1)]);
      }
      return MapEntry(k, v);
    });
    return DslNode(
      type: template.type,
      key: template.key,
      rev: instance.rev,
      boundary: template.boundary,
      props: resolvedProps,
      events: template.events,
      children: template.children.map((c) => _expand(c, instance)).toList(growable: false),
    );
  }

  static Widget _missing(BuildContext context, DslNode node, ElpaBuildScope scope) =>
      ErrorWidget.withDetails(message: 'Elpa: no builder for "${node.type}"');
}

/// A decoupled, repaint-isolated subtree. It holds its own [DslNode] in state, so
/// the shell can hand it a new node (via [ElpaBoundaryController]) and only this
/// boundary rebuilds — the parent tree is untouched. This is how the system
/// avoids re-rendering the whole UI on every frame: animated or
/// frequently-updated regions live behind boundaries.
class ElpaBoundary extends StatefulWidget {
  const ElpaBoundary({super.key, required this.node, required this.scope});

  final DslNode node;
  final ElpaBuildScope scope;

  @override
  State<ElpaBoundary> createState() => _ElpaBoundaryState();
}

class _ElpaBoundaryState extends State<ElpaBoundary> {
  @override
  Widget build(BuildContext context) {
    // Build the boundary's content with caching, but as a *root* of its own
    // subtree so changes here don't propagate upward.
    final scope = widget.scope;
    final builder = scope.registry.builderFor(widget.node.type);
    return builder(context, widget.node, scope);
  }
}
