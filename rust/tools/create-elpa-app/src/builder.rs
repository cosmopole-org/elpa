//! `build` — transpile the TypeScript app to a single VM-subset bundle and
//! compile that bundle to Elpian bytecode.
//!
//! Output (in the manifest's `outDir`):
//!   * `app.js`  — the final bundle: runtime prelude + vendored SDK modules +
//!                 the transpiled/flattened TypeScript app.
//!   * `app.bc`  — the compiled Elpian bytecode for that bundle.

use std::path::{Path, PathBuf};

use crate::manifest::Manifest;
use crate::transpile;

pub struct BuildOutput {
    pub js: PathBuf,
    pub bc: PathBuf,
    pub js_len: usize,
    pub bc_len: usize,
}

/// Assemble and compile the project. `quiet` suppresses the per-step log (used
/// when `init` builds the freshly scaffolded project).
pub fn build(m: &Manifest, quiet: bool) -> Result<BuildOutput, String> {
    if !quiet {
        println!("Building \"{}\" ({})", m.name, m.template);
    }

    // 1. Transpile + bundle the TypeScript app.
    if !m.entry.is_file() {
        return Err(format!("entry not found: {}", m.entry.display()));
    }
    let app = transpile::bundle(&m.entry)?;

    // 2. Assemble the full program: prelude + SDK (lexical order) + app.
    let mut program = String::new();
    program.push_str("// ==== Elpa runtime prelude ====\n");
    program.push_str(transpile::PRELUDE);
    program.push('\n');
    for dir in &m.sdk {
        for file in sorted_js(dir)? {
            program.push_str(&format!("// ==== sdk: {} ====\n", rel(&file, &m.root)));
            program.push_str(&std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?);
            program.push('\n');
        }
    }
    program.push_str("// ==== app ====\n");
    program.push_str(&app);

    // 3. Compile to bytecode (validates the whole program through the VM).
    let bytecode = elpian_vm::api::compile_js_to_bytecode(&program)
        .ok_or("the bundle failed to compile to Elpian bytecode (a syntax/feature outside the VM subset?)")?;

    // 4. Write outputs.
    std::fs::create_dir_all(&m.out_dir).map_err(|e| format!("mkdir {}: {e}", m.out_dir.display()))?;
    let js = m.out_dir.join("app.js");
    let bc = m.out_dir.join("app.bc");
    std::fs::write(&js, &program).map_err(|e| format!("write {}: {e}", js.display()))?;
    std::fs::write(&bc, &bytecode).map_err(|e| format!("write {}: {e}", bc.display()))?;

    // Optional: prelude + app (no SDK), for hosts that load the SDK separately.
    if let Some(app_out) = &m.app_out {
        if let Some(parent) = app_out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let loader = format!("// ==== Elpa runtime prelude ====\n{}\n// ==== app ====\n{}", transpile::PRELUDE, app);
        std::fs::write(app_out, &loader).map_err(|e| format!("write {}: {e}", app_out.display()))?;
    }

    let out = BuildOutput { js, bc, js_len: program.len(), bc_len: bytecode.len() };
    if !quiet {
        println!("  bundle:   {} ({} chars)", rel(&out.js, &m.root), out.js_len);
        println!("  bytecode: {} ({} bytes)", rel(&out.bc, &m.root), out.bc_len);
        if let Some(app_out) = &m.app_out {
            println!("  loader:   {}", rel(app_out, &m.root));
        }
    }
    Ok(out)
}

/// `.js` files in a directory, lexically sorted (the SDK link order).
fn sorted_js(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Err(format!("sdk directory not found: {}", dir.display()));
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "js").unwrap_or(false))
        .collect();
    files.sort();
    Ok(files)
}

fn rel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).display().to_string()
}
