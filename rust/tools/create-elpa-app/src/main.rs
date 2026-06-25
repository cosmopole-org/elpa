//! create-elpa-app — scaffold, build, and serve Elpa applications authored in
//! TypeScript.
//!
//!   create-elpa-app init <name> --template <wgpu|flutter|wgpu-flutter>
//!   create-elpa-app build           # transpile + bundle TS → JS + Elpian bytecode
//!   create-elpa-app dev             # build, then serve for the prebuilt wasm host
//!   create-elpa-app install         # build the default Elpa + Flutter wasm host
//!
//! The TypeScript app (one component per file) is bundled into a single
//! VM-subset script by an embedded swc-based transpiler (see `transpile.rs`) and
//! compiled to bytecode by the Elpian VM.

mod builder;
mod install;
mod manifest;
mod scaffold;
mod serve;
mod transpile;

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = dispatch(&args);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("\x1b[31merror:\x1b[0m {e}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(args: &[String]) -> Result<(), String> {
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };

    match cmd {
        "" | "-h" | "--help" | "help" => {
            usage();
            Ok(())
        }
        "init" | "new" | "create" => scaffold::run_init(rest),
        "build" => {
            let m = manifest::Manifest::find(&cwd())?;
            builder::build(&m, false).map(|_| ())
        }
        "dev" => {
            let port = parse_port(rest)?;
            serve::dev(&cwd(), port)
        }
        "install" => {
            let force = rest.iter().any(|a| a == "--force");
            let root = scaffold::find_elpa_root(flag_value(rest, "--elpa-root").as_deref())?;
            install::install(&root, force)
        }
        // Back-compat / convenience: `create-elpa-app "My App" -t wgpu` implies init.
        _ => scaffold::run_init(args),
    }
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn parse_port(args: &[String]) -> Result<u16, String> {
    match flag_value(args, "--port") {
        Some(v) => v.parse().map_err(|_| format!("invalid --port: {v}")),
        None => Ok(serve::DEFAULT_PORT),
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
}

fn usage() {
    println!("create-elpa-app — scaffold, build, and serve Elpa apps written in TypeScript\n");
    println!("Usage:");
    println!("  create-elpa-app init <name> [--template <type>] [--dir <path>] [--force]");
    println!("  create-elpa-app build");
    println!("  create-elpa-app dev [--port <n>]");
    println!("  create-elpa-app install [--force]\n");
    println!("Templates:");
    for (k, label) in scaffold::TEMPLATES {
        println!("  {k:<14}{label}");
    }
    println!("\nCommands:");
    println!("  init      create a new project (vendors the engine + SDK, builds it once)");
    println!("  build     transpile the TS app → one VM-subset JS bundle + Elpian bytecode");
    println!("  dev       build, then serve the bytecode for the prebuilt Elpa+Flutter wasm host");
    println!("  install   build that default wasm host (needs the Flutter + wasm toolchain)");
    println!("\nWith no name/template, `init` prompts interactively.");
}
