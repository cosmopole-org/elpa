/// Entry point of the Elpa + Rust + Flutter demo.
///
/// Boots the native bridge, loads the demo Elpa app's JavaScript from assets, and
/// hands it to [ElpaApp], which runs it on the Elpian VM and renders it as a
/// Flutter UI over the message pipe.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'package:elpa_app/elpa.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Load the native engine (the flutter_rust_bridge dynamic library) and the
  // app's program. Both happen once at startup.
  final bridge = await RustElpaBridge.init();
  final jsSource = await rootBundle.loadString('assets/app/main.js');

  runApp(ElpaDemoApp(bridge: bridge, jsSource: jsSource));
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
