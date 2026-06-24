/// The decoded form of the **Elpa Flutter DSL** — the widget-tree description an
/// Elpa app streams over the pipe on the `flutter.render` channel.
///
/// A node is intentionally close to the wire JSON so decoding is cheap:
///
/// ```json
/// {
///   "type": "Column",
///   "key": "root",
///   "rev": 7,
///   "boundary": true,
///   "props": { "mainAxisAlignment": "center" },
///   "children": [
///     { "type": "Text", "props": { "text": "Hello" } },
///     { "type": "Button", "key": "inc", "props": { "label": "+" },
///       "events": { "onTap": "inc" } }
///   ]
/// }
/// ```
///
/// * **type** selects the builder (a built-in or an app-defined custom widget).
/// * **key** identifies the node across rebuilds — the anchor for caching and
///   for Flutter element reuse.
/// * **rev** is a monotonic revision the app bumps only when the subtree changed;
///   the cache reuses a node's previously-built widget while its `rev` is stable,
///   so unchanged branches are never rebuilt.
/// * **boundary** marks a decoupling point: the subtree becomes its own stateful
///   widget wrapped in a `RepaintBoundary`, so a change inside it neither rebuilds
///   nor repaints the rest of the tree.
/// * **events** maps a gesture name to an app callback id sent back on
///   `flutter.event`.
library;

import 'package:meta/meta.dart';

@immutable
class DslNode {
  const DslNode({
    required this.type,
    this.key,
    this.rev,
    this.boundary = false,
    this.props = const {},
    this.events = const {},
    this.children = const [],
  });

  final String type;
  final String? key;
  final int? rev;
  final bool boundary;
  final Map<String, Object?> props;

  /// gesture/event name → app callback id (sent back on `flutter.event`).
  final Map<String, String> events;
  final List<DslNode> children;

  /// A stable identity for caching: the explicit key, else a structural fallback.
  String identity(int siblingIndex) => key ?? '$type#$siblingIndex';

  static DslNode fromJson(Map<String, Object?> json) {
    final childrenRaw = json['children'];
    final eventsRaw = json['events'];
    return DslNode(
      type: (json['type'] as String?) ?? 'Empty',
      key: json['key'] as String?,
      rev: (json['rev'] as num?)?.toInt(),
      boundary: (json['boundary'] as bool?) ?? false,
      props: (json['props'] as Map?)?.cast<String, Object?>() ?? const {},
      events: eventsRaw is Map
          ? eventsRaw.map((k, v) => MapEntry(k.toString(), v.toString()))
          : const {},
      children: childrenRaw is List
          ? childrenRaw
              .whereType<Map>()
              .map((c) => DslNode.fromJson(c.cast<String, Object?>()))
              .toList(growable: false)
          : const [],
    );
  }

  /// Typed prop accessors with defaults — keep builders terse.
  T? prop<T>(String name) => props[name] is T ? props[name] as T : null;
  double propDouble(String name, [double fallback = 0]) =>
      (props[name] as num?)?.toDouble() ?? fallback;
  String propString(String name, [String fallback = '']) =>
      props[name]?.toString() ?? fallback;
  bool propBool(String name, [bool fallback = false]) =>
      (props[name] as bool?) ?? fallback;
}
