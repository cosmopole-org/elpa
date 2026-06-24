//! Build-time bytecode generator for the Liquid Glass example.
//!
//! Elpa's pipeline is `JS ──▶ AST JSON ──▶ bytecode ──▶ VM`. This tool runs the
//! compiler phase ahead of time — at build / deploy — lowering the program to VM
//! bytecode once and writing it to `assets/demo.bc`, which the web and native
//! hosts can `include_bytes!` and load via `Elpa::new_from_bytecode`, so the
//! deployed app starts straight at the VM with no front-end work.
//!
//! ```sh
//! cargo run -p elpa-liquidglass --bin build_bytecode
//! ```

use std::fs;
use std::path::Path;

use elpian_vm::api::compile_js_to_bytecode;

fn programs() -> Vec<(&'static str, String)> {
    vec![
        ("demo.bc", elpa_liquidglass::program()),
        ("calculator.bc", elpa_liquidglass::calculator_program()),
    ]
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
