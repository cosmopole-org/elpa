//! `install` — build the default prebuilt **Elpa + Flutter wasm host** that the
//! `dev` server serves.
//!
//! The host is a Flutter web app (compiled to WebAssembly) that embeds the Elpa
//! engine through `flutter_rust_bridge` and, at startup, fetches `/app.bc` and
//! runs it. `install` materializes it once into a shared cache so every project's
//! `dev` server can reuse it.
//!
//! This step needs the Flutter SDK, the `flutter_rust_bridge_codegen` tool and a
//! wasm-capable Rust toolchain. When any is missing the command stops with the
//! exact remediation rather than guessing — building a multi-hundred-megabyte
//! Flutter/wasm artifact is never silent.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Shared cache location for the prebuilt wasm host's web root.
pub fn host_dir() -> PathBuf {
    let base = std::env::var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".cache")
        });
    base.join("elpa").join("web-host")
}

pub fn install(elpa_root: &Path, force: bool) -> Result<(), String> {
    let host = host_dir();
    if host.join("index.html").is_file() && !force {
        println!("\x1b[32m✓\x1b[0m wasm host already installed at {}", host.display());
        println!("  re-run with --force to rebuild.");
        return Ok(());
    }

    // The Flutter host project that embeds Elpa (vendored in the repo).
    let project = elpa_root.join("flutter");
    if !project.join("pubspec.yaml").is_file() {
        return Err(format!("Flutter host project not found at {}", project.display()));
    }

    // Preflight: every external tool the build needs.
    require_tool(
        "flutter",
        &["--version"],
        "Install Flutter: https://docs.flutter.dev/get-started/install (and run `flutter config --enable-web`).",
    )?;
    require_tool(
        "flutter_rust_bridge_codegen",
        &["--version"],
        "Install the bridge codegen: `cargo install flutter_rust_bridge_codegen`.",
    )?;
    // wasm host build uses the standard web toolchain; the rest is checked by Flutter itself.

    println!("Building the Elpa + Flutter wasm host (this is heavy and runs once)…");
    println!("  project: {}", project.display());

    run(&project, "flutter", &["pub", "get"])?;
    run(&project, "flutter_rust_bridge_codegen", &["generate"])?;
    // `--wasm` selects the WebAssembly renderer/output.
    run(&project, "flutter", &["build", "web", "--wasm", "--release"])?;

    // Publish build/web → the shared cache.
    let web = project.join("build").join("web");
    if !web.join("index.html").is_file() {
        return Err(format!("expected Flutter web build at {} but it is missing", web.display()));
    }
    if host.exists() {
        let _ = std::fs::remove_dir_all(&host);
    }
    std::fs::create_dir_all(host.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::scaffold::copy_tree(&web, &host).map_err(|e| format!("publish host: {e}"))?;

    println!("\x1b[32m✓\x1b[0m wasm host installed at {}", host.display());
    println!("  `create-elpa-app dev` will serve it with your project's bytecode.");
    Ok(())
}

fn require_tool(bin: &str, probe: &[&str], remedy: &str) -> Result<(), String> {
    match Command::new(bin).args(probe).output() {
        Ok(_) => Ok(()),
        Err(_) => Err(format!("`{bin}` is required but was not found.\n  {remedy}")),
    }
}

fn run(dir: &Path, bin: &str, args: &[&str]) -> Result<(), String> {
    println!("  $ {bin} {}", args.join(" "));
    let status = Command::new(bin)
        .args(args)
        .current_dir(dir)
        .status()
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    if !status.success() {
        return Err(format!("`{bin} {}` failed ({status})", args.join(" ")));
    }
    Ok(())
}
