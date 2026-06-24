/// Public API of the Elpa Flutter layer.
///
/// Import this to embed an Elpa program as a Flutter UI:
///
/// ```dart
/// final bridge = await RustElpaBridge.init();
/// runApp(MaterialApp(home: ElpaApp(bridge: bridge, jsSource: mySource)));
/// ```
library elpa;

export 'src/elpa/bridge.dart';
export 'src/elpa/bridge_rust.dart';
export 'src/elpa/engine.dart';
export 'src/elpa/message_pipe.dart';
export 'src/elpa/elpa_shell.dart';
export 'src/elpa/dsl/dsl_node.dart';
export 'src/elpa/dsl/cache.dart';
export 'src/elpa/dsl/widget_builder.dart';
export 'src/elpa/native/elpa_texture.dart';
export 'src/elpa/widgets/elpa_host_widget.dart';
