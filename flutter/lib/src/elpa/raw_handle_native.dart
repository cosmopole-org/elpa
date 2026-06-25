/// Native variant of the `i64` (PlatformInt64) conversion used by
/// [RustElpaBridge.registerSurface]. On native targets a Dart `int` is a true
/// 64-bit integer, so flutter_rust_bridge maps Rust `i64` straight to `int` and
/// no conversion is needed. The web counterpart lives in `raw_handle_web.dart`
/// and is selected by the conditional import in `bridge_rust.dart`.
library;

int toRawHandle(int value) => value;
