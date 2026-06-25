/// Web variant of the `i64` (PlatformInt64) conversion used by
/// [RustElpaBridge.registerSurface]. On the web a Dart `int` is a 53-bit JS
/// number, so flutter_rust_bridge maps Rust `i64` to `BigInt`; convert here. The
/// native counterpart lives in `raw_handle_native.dart` and is selected by the
/// conditional import in `bridge_rust.dart`.
library;

BigInt toRawHandle(int value) => BigInt.from(value);
