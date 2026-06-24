/// Entry point of the Elpa + Rust + Flutter demo.
///
/// Boots the native bridge, loads the demo Elpa app's JavaScript from assets, and
/// hands it to [ElpaApp], which runs it on the Elpian VM and renders it as a
/// Flutter UI over the message pipe.
///
/// The app is authored against the **Elpa SDK** (`assets/app/sdk/*.js`): an
/// object-oriented authoring layer (widgets, components, timing, graphics,
/// navigation, theme). The SDK modules and the app source are concatenated into a
/// single program in [bundledAppSource] before being compiled on the VM — the
/// Elpian VM compiles one source unit, so the "modules" are a load-time bundle.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'package:elpa_app/elpa.dart';

/// The Elpa SDK modules, in dependency order, followed by the app entry point.
/// This is the bundle manifest; the Rust end-to-end test mirrors it so both halves
/// compile the exact same program.
const List<String> kAppSources = [
  'assets/app/sdk/00_core.js',
  'assets/app/sdk/01_theme.js',
  'assets/app/sdk/02_widgets.js',
  'assets/app/sdk/03_reactive.js',
  'assets/app/sdk/04_timing.js',
  'assets/app/sdk/05_graphics.js',
  'assets/app/sdk/06_navigation.js',
  'assets/app/sdk/07_app.js',
  'assets/app/main.js',
];

/// Load and concatenate the SDK modules + the app into one VM program.
Future<String> bundledAppSource() async {
  final parts = await Future.wait(kAppSources.map(rootBundle.loadString));
  return parts.join('\n');
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  try {
    // Load the native engine (the flutter_rust_bridge dynamic library) and the
    // app's program. Both happen once at startup.
    final bridge = await RustElpaBridge.init();
    final jsSource = await bundledAppSource();

    runApp(ElpaDemoApp(bridge: bridge, jsSource: jsSource));
  } catch (error, stackTrace) {
    // Booting the native bridge can fail before the first frame — e.g. the
    // platform library not being bundled (Android), or the wasm refusing to
    // instantiate on a page that isn't cross-origin isolated (web). Show the
    // error instead of leaving a blank white screen with no clue why.
    runApp(_StartupErrorApp(error: error, stackTrace: stackTrace));
  }
}

/// Last-resort UI shown when the engine fails to boot, so a startup failure is
/// visible (and diagnosable) rather than an unexplained blank screen.
class _StartupErrorApp extends StatelessWidget {
  const _StartupErrorApp({required this.error, required this.stackTrace});

  final Object error;
  final StackTrace stackTrace;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Elpa + Rust + Flutter',
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Elpa failed to start',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 12),
                Text('$error'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ElpaDemoApp extends StatelessWidget {
  const ElpaDemoApp({super.key, required this.bridge, required this.jsSource});

  final ElpaBridge bridge;
  final String jsSource;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Elpa + Rust + Flutter',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      // The whole UI of this route is produced by the Elpa program.
      home: ElpaApp(bridge: bridge, jsSource: jsSource),
    );
  }
}
