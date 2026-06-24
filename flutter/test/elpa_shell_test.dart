// Widget tests for the Elpa DSL → Flutter rendering, driven through a fake
// bridge so they need no native engine. Run with `flutter test`.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:elpa_app/elpa.dart';

/// A scripted [ElpaBridge] that replays canned messages — no Rust/VM involved.
class FakeBridge implements ElpaBridge {
  FakeBridge(this.onStart);

  /// Messages returned from [start] (the initial render).
  final List<ElpaMessage> onStart;

  /// Messages captured from [post], so a test can assert what the UI sent back.
  final List<(String, String)> posted = [];

  /// Scripted reply to the next [post] (e.g. a re-render after a tap).
  List<ElpaMessage> Function(String channel, String payload)? onPost;

  @override
  Future<ElpaChannels> channels() async => const ElpaChannels(
        render: 'flutter.render',
        patch: 'flutter.patch',
        invalidate: 'flutter.invalidate',
        define: 'flutter.define',
        event: 'flutter.event',
      );

  @override
  Future<int?> createFromJs(String s, int w, int h, double sc) async => 1;
  @override
  Future<int?> createFromBytecode(List<int> b, int w, int h, double sc) async => 1;

  @override
  Future<List<ElpaMessage>> start(int handle) async => onStart;

  @override
  Future<List<ElpaMessage>> post(int handle, String channel, String payload) async {
    posted.add((channel, payload));
    return onPost?.call(channel, payload) ?? const [];
  }

  @override
  Future<void> dispose(int handle) async {}
  @override
  Future<List<ElpaMessage>> pointer(int h, ElpaPointerPhase p, double x, double y, int b) async =>
      const [];
  @override
  Future<List<ElpaMessage>> wheel(int h, double x, double y, double d) async => const [];
  @override
  Future<List<ElpaMessage>> key(int h, bool down, String k) async => const [];
  @override
  Future<List<ElpaMessage>> frame(int h, double dt) async => const [];
  @override
  Future<List<ElpaMessage>> resize(int h, int w, int ht, double sc) async => const [];
  @override
  Future<List<ElpaMessage>> safeArea(int h, double t, double r, double b, double l) async =>
      const [];
  @override
  Future<List<String>> takeLog(int h) async => const [];
}

void main() {
  testWidgets('renders a DSL tree and forwards tap events', (tester) async {
    const renderJson = '{"type":"Column","key":"root","children":['
        '{"type":"Text","key":"label","props":{"text":"Hello Elpa"}},'
        '{"type":"Button","key":"go","props":{"label":"Go"},"events":{"onTap":"go"}}'
        ']}';

    final bridge = FakeBridge([const ElpaMessage('flutter.render', renderJson)]);
    final engine = await ElpaEngine.bootFromJs(
      bridge,
      jsSource: '',
      width: 400,
      height: 800,
      scale: 1.0,
    );

    await tester.pumpWidget(MaterialApp(home: ElpaShell(engine: engine!)));
    await tester.pump(); // let the start() future + setState settle.

    expect(find.text('Hello Elpa'), findsOneWidget);
    expect(find.text('Go'), findsOneWidget);

    // Tapping the DSL button sends a flutter.event back to the VM.
    await tester.tap(find.text('Go'));
    await tester.pump();

    expect(bridge.posted, isNotEmpty);
    expect(bridge.posted.last.$1, 'flutter.event');
    expect(bridge.posted.last.$2, contains('"handler":"go"'));
  });

  testWidgets('a scoped patch rebuilds only its scope, not its sibling',
      (tester) async {
    // A build-counting probe so we can observe exactly which scopes rebuilt.
    final builds = <String, int>{};
    final registry = ElpaWidgetRegistry(<String, ElpaNodeBuilder>{
      'Probe': (context, node, scope) {
        final key = node.key ?? '?';
        builds[key] = (builds[key] ?? 0) + 1;
        return Text(node.propString('label'), textDirection: TextDirection.ltr);
      },
    });
    final scopes = ScopeRegistry();
    final buildScope = ElpaBuildScope(
      registry: registry,
      cache: WidgetCache(),
      scopes: scopes,
      dispatch: (_, __) {},
    );

    DslNode probe(String key, String label) =>
        DslNode(type: 'Probe', key: key, boundary: true, props: {'label': label});

    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Column(children: [
        ElpaScope(key: const ValueKey('A'), node: probe('A', 'A0'), scope: buildScope),
        ElpaScope(key: const ValueKey('B'), node: probe('B', 'B0'), scope: buildScope),
      ]),
    ));

    expect(builds, {'A': 1, 'B': 1}, reason: 'both scopes built once initially');
    expect(scopes.has('A') && scopes.has('B'), isTrue, reason: 'both registered');

    // Patch only scope A. The registry drives A's own setState directly.
    final handled = scopes.update('A', probe('A', 'A1'));
    expect(handled, isTrue, reason: 'A is mounted, so the update is isolated');
    await tester.pump();

    expect(builds['A'], 2, reason: 'scope A rebuilt');
    expect(builds['B'], 1, reason: 'scope B was NOT rebuilt');
    expect(find.text('A1'), findsOneWidget);
    expect(find.text('B0'), findsOneWidget);

    // Invalidating a scope rebuilds only it as well.
    scopes.invalidate('B');
    await tester.pump();
    expect(builds['A'], 2, reason: 'A untouched by B invalidation');
    expect(builds['B'], 2, reason: 'B rebuilt by invalidation');

    // An update for an unmounted key is not handled (caller falls back).
    expect(scopes.update('missing', probe('missing', 'x')), isFalse);
  });

  test('WidgetCache reuses a widget while rev is stable', () {
    final cache = WidgetCache();
    const a = SizedBox(width: 1);
    cache.put('n', 5, a);
    expect(identical(cache.get('n', 5), a), isTrue, reason: 'same rev → reuse');
    expect(cache.get('n', 6), isNull, reason: 'new rev → rebuild');
    cache.invalidate('n');
    expect(cache.get('n', 5), isNull, reason: 'invalidated → rebuild');
  });
}
