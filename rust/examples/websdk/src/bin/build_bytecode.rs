//! Build-time bytecode generator for the Web SDK example. Lowers the program to
//! VM bytecode (`assets/demo.bc`) so a host can `include_bytes!` it and start
//! straight at the VM via `Elpa::new_from_bytecode`.
//!
//! ```sh
//! cargo run -p elpa-websdk --bin build_bytecode
//! ```

use std::fs;
use std::path::Path;

use elpian_vm::api::compile_js_to_bytecode;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    fs::create_dir_all(&dir).expect("create assets dir");
    let src = elpa_websdk::program();
    let bytecode = compile_js_to_bytecode(&src)
        .expect("program is outside the supported JS subset");
    let path = dir.join("demo.bc");
    fs::write(&path, &bytecode).expect("write bytecode asset");
    println!("wrote assets/demo.bc ({} bytes, from {} bytes of JS)", bytecode.len(), src.len());
}
