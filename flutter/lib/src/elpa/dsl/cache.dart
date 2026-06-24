/// The caching + decoupling machinery that keeps DSL rendering cheap.
///
/// Three cooperating mechanisms, all required by the design:
///
/// 1. **Revision memoization** ([WidgetCache]) — a node carrying a `rev` reuses
///    its previously-built `Widget` instance while `rev` is unchanged. Returning
///    the identical instance lets Flutter short-circuit the subtree's rebuild, so
///    an app that bumps only the `rev`s that actually changed pays to rebuild
///    *only* those branches.
/// 2. **Render scopes** ([ElpaScope] + [ScopeRegistry]) — a node marked
///    `boundary: true` becomes a self-contained `StatefulWidget` wrapped in a
///    `RepaintBoundary` and registered by key. A `flutter.patch` / `flutter.invalidate`
///    addressed to that key drives the scope's *own* `setState` directly (the
///    shell never rebuilds), so a change inside it rerenders only it — siblings
///    and ancestors are neither rebuilt nor repainted.
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
    required this.scopes,
    required this.dispatch,
  });

  final ElpaWidgetRegistry registry;
  final WidgetCache cache;

  /// The live registry of mounted render scopes, so a scoped update can reach
  /// exactly one boundary's State without rebuilding the shell.
  final ScopeRegistry scopes;

  final ElpaEventSink dispatch;

  /// Build a single child, applying caching and boundary wrapping. [index] is the
  /// child's sibling position, used for structural identity when it has no key.
  Widget build(BuildContext context, DslNode node, int index) {
    final id = node.identity(index);

    // A boundary becomes its own stateful + repaint-isolated render scope, keyed
    // stably by its identity so its State (and thus its in-place updatability)
    // survives shell rebuilds.
    if (node.boundary) {
      return RepaintBoundary(
        key: ValueKey('elpa.scope.$id'),
        child: ElpaScope(key: ValueKey('elpa.scope.state.$id'), node: node, scope: this),
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

/// The live index of mounted [ElpaScope]s, keyed by node key. It is how a scoped
/// update (`flutter.patch` / `flutter.invalidate`) reaches exactly one render
/// scope's State in O(1) — the shell routes the message here instead of calling
/// `setState`, so only that scope rebuilds and repaints. Sibling and ancestor
/// scopes are never touched.
class ScopeRegistry {
  final Map<String, _ElpaScopeState> _scopes = {};

  /// Whether a scope with [key] is currently mounted (so the shell knows it can
  /// route an isolated update instead of falling back to a full rebuild).
  bool has(String key) => _scopes.containsKey(key);

  /// Replace a mounted scope's subtree in place. Returns `false` if no scope with
  /// [key] is mounted (the caller then falls back to a full-tree update).
  bool update(String key, DslNode node) {
    final state = _scopes[key];
    if (state == null) return false;
    state.applyUpdate(node);
    return true;
  }

  /// Force a mounted scope to rebuild without changing its node (e.g. after a
  /// dependency it reads changed). Returns `false` if not mounted.
  bool invalidate(String key) {
    final state = _scopes[key];
    if (state == null) return false;
    state.applyInvalidate();
    return true;
  }

  void _register(String key, _ElpaScopeState state) => _scopes[key] = state;

  void _unregister(String key, _ElpaScopeState state) {
    if (identical(_scopes[key], state)) _scopes.remove(key);
  }
}

/// A decoupled, repaint-isolated **render scope**. It holds its own [DslNode] in
/// State and registers itself in the [ScopeRegistry], so a scoped update can
/// drive *its own* `setState` directly — the shell never rebuilds. This is what
/// makes "a state change in one widget rerenders only that widget" true: Flutter
/// marks only this Element dirty, and the surrounding [RepaintBoundary] confines
/// the repaint, so siblings and ancestors are neither rebuilt nor repainted.
///
/// Both update paths stay coherent:
/// * a scoped `flutter.patch` calls [applyUpdate] → only this scope rebuilds;
/// * a full `flutter.render` rebuilds the shell, which hands this scope a fresh
///   node via [didUpdateWidget] → it adopts it. (The shell mirrors the patch into
///   its root model, so the node the shell would pass is identical to the patched
///   one and never clobbers an in-place update.)
class ElpaScope extends StatefulWidget {
  const ElpaScope({super.key, required this.node, required this.scope});

  final DslNode node;
  final ElpaBuildScope scope;

  @override
  State<ElpaScope> createState() => _ElpaScopeState();
}

class _ElpaScopeState extends State<ElpaScope> {
  late DslNode _node;

  String get _key => _node.key ?? '';

  @override
  void initState() {
    super.initState();
    _node = widget.node;
    widget.scope.scopes._register(_key, this);
  }

  @override
  void didUpdateWidget(covariant ElpaScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A shell rebuild re-seeds this scope. Only adopt when the node actually
    // differs from what we hold, so a structurally-shared (unchanged) rebuild —
    // or one carrying the same node we were just patched with — is a no-op and
    // never overwrites an in-place update.
    if (!identical(widget.node, _node)) {
      final newKey = widget.node.key ?? '';
      if (newKey != _key) widget.scope.scopes._unregister(_key, this);
      _node = widget.node;
      widget.scope.scopes._register(_key, this);
    }
  }

  /// Replace this scope's subtree in place (the isolated-rebuild path).
  void applyUpdate(DslNode node) {
    if (!mounted) return;
    setState(() => _node = node);
  }

  /// Rebuild this scope without changing its node.
  void applyInvalidate() {
    if (!mounted) return;
    setState(() {});
  }

  @override
  void dispose() {
    widget.scope.scopes._unregister(_key, this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Build this scope's content as the root of its own subtree; children flow
    // back through [ElpaBuildScope.build] so nested scopes and the rev cache
    // apply recursively inside it.
    final s = widget.scope;
    final builder = s.registry.builderFor(_node.type);
    return builder(context, _node, s);
  }
}
