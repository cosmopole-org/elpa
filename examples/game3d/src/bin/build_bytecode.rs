//! Build-time bytecode generator for the Game3D example.
//!
//! Elpa's pipeline is `JS ──▶ AST JSON ──▶ bytecode ──▶ VM`. This tool runs the
//! compiler phase ahead of time — at build / deploy — lowering the engine + demo
//! program to VM bytecode once and writing it to `assets/demo.bc`. A host can
//! then `include_bytes!` the blob and load it with `Elpa::new_from_bytecode`, so
//! the deployed app starts straight at the VM with no front-end work.
//!
//! Run it with:
//!
//! ```sh
//! cargo run -p elpa-game3d --bin build_bytecode
//! ```

use std::fs;
use std::path::Path;

use elpian_vm::api::compile_js_to_bytecode;

fn programs() -> Vec<(&'static str, String)> {
    vec![("demo.bc", elpa_game3d::program())]
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    fs::create_dir_all(&dir).expect("create assets dir");

    for (name, src) in programs() {
        let bytecode = compile_js_to_bytecode(&src)
            .unwrap_or_else(|| panic!("{name}: program is outside the supported JS subset"));
        let path = dir.join(name);
        fs::write(&path, &bytecode).expect("write bytecode asset");
        println!(
            "wrote assets/{name} ({} bytes, from {} bytes of JS)",
            bytecode.len(),
            src.len()
        );
    }
}
