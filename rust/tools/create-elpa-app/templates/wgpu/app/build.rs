// Build step: concatenate the Game3D SDK modules (in lexical order) followed by
// the demo program into one JavaScript source the VM compiles at startup. The
// concatenation is written to OUT_DIR/program.js and pulled in with include_str!
// (see src/main.rs), so adding or renaming an SDK module is picked up
// automatically on the next build.
//
// The Material SDK is also vendored (assets/sdk/material/) for you to build a
// pure-2D Elpa app from; it is not concatenated here because Game3D drives the
// surface in this combined 3D + 2D demo. See README.md.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let assets = manifest.join("assets");
    let sdk_dir = assets.join("sdk").join("game3d");
    let demo = assets.join("demo.js");

    let mut sources: Vec<PathBuf> = fs::read_dir(&sdk_dir)
        .expect("read Game3D SDK dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "js").unwrap_or(false))
        .collect();
    sources.sort();

    let mut program = String::new();
    for src in &sources {
        program.push_str(&fs::read_to_string(src).expect("read SDK module"));
        program.push('\n');
        rerun(src);
    }
    program.push_str(&fs::read_to_string(&demo).expect("read demo.js"));
    rerun(&demo);

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("program.js");
    fs::write(&out, program).expect("write concatenated program");
}

fn rerun(p: &Path) {
    println!("cargo:rerun-if-changed={}", p.display());
}
