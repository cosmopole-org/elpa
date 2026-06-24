//! Build-time bytecode generator for the Material examples.
//!
//! Elpa's pipeline is `JS ──▶ AST JSON ──▶ bytecode ──▶ VM`. The web and native
//! examples used to run the whole pipeline *at app startup*, compiling the
//! ~thousands of lines of Material SDK JavaScript on every launch. This tool
//! runs the **compiler phase ahead of time** — at build / deploy — lowering each
//! program to VM bytecode once and writing it to `assets/*.bc`. The examples
//! then `include_bytes!` those blobs and load them with
//! `Elpa::new_from_bytecode`, so the deployed app starts straight at the VM with
//! no front-end work.
//!
//! Run it with:
//!
//! ```sh
//! cargo run -p elpa-material --bin build_bytecode
//! ```
//!
//! It is also run in CI before the web (Pages) and Android (APK) builds, so the
//! shipped bytecode always reflects the current JS sources.

use std::fs;
use std::path::Path;

use elpian_vm::api::compile_js_to_bytecode;

/// The programs the examples ship, each as `(asset file name, JS source)`.
/// `gallery` is what the web and native examples run; `demo` and `graphics` are
/// the alternative apps the same hosts can load (and keep their bytecode fresh
/// for anyone who swaps them in).
fn programs() -> Vec<(&'static str, String)> {
    vec![
        ("gallery.bc", elpa_material::gallery_program()),
        ("demo.bc", elpa_material::program()),
        ("graphics.bc", elpa_material::graphics_program()),
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
