//! `init` — scaffold a new Elpa project from a template, vendoring the live
//! engine + SDK sources, then run an initial `build`.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::builder;
use crate::manifest::Manifest;

/// The repo this tool ships in (…/rust/tools/create-elpa-app → repo root is three
/// up), baked at compile time as the default source of engine + Flutter sources.
pub const DEFAULT_ELPA_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
const TEMPLATES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/templates");

const ENGINE_CRATES: [&str; 5] = ["elpa", "elpian-vm", "elpa-protocol", "elpa-renderer", "elpa-runtime"];

pub const TEMPLATES: [(&str, &str); 3] = [
    ("wgpu", "wgpu — TypeScript on wgpu (Game3D 3D scene + Material-styled 2D HUD)"),
    ("flutter", "flutter — Flutter + flutter_rust_bridge + Elpa, rich 2D UI in TypeScript"),
    ("wgpu-flutter", "wgpu-flutter — Flutter + Elpa with a 3D Native3DView (wgpu) inside a 2D UI"),
];

// ---- string helpers ---------------------------------------------------------

pub struct Vars {
    pub name: String,
    pub snake: String,
    pub title: String,
}

pub fn snake_case(name: &str) -> String {
    let mut out = String::new();
    let mut prev_was_lower = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if ch.is_ascii_uppercase() && prev_was_lower {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
            prev_was_lower = ch.is_ascii_lowercase();
        } else {
            if !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
            prev_was_lower = false;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    let s = if trimmed.is_empty() { "elpa_app".to_string() } else { trimmed };
    if s.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        format!("_{s}")
    } else {
        s
    }
}

fn title_case(name: &str) -> String {
    name.split(|c: char| c == '_' || c == '-' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn substitute(text: &str, v: &Vars) -> String {
    text.replace("__APP_SNAKE__", &v.snake)
        .replace("__APP_TITLE__", &v.title)
        .replace("__APP_NAME__", &v.name)
}

// ---- filesystem helpers -----------------------------------------------------

fn skip_name(name: &str, extra: &[&str]) -> bool {
    matches!(name, "target" | "build" | ".dart_tool" | "node_modules") || extra.contains(&name)
}

/// Recursively copy a directory, skipping build artifacts (and `extra` names).
pub fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    copy_dir(src, dst, &[])
}

fn copy_dir(src: &Path, dst: &Path, extra: &[&str]) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip_name(&name, extra) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&*name);
        if entry.file_type()?.is_dir() {
            copy_dir(&from, &to, extra)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn emit_template(templates: &Path, rel: &str, dst: &Path, v: &Vars) -> Result<(), String> {
    let tpl = fs::read_to_string(templates.join(rel)).map_err(|e| format!("read template {rel}: {e}"))?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(dst, substitute(&tpl, v)).map_err(|e| format!("write {}: {e}", dst.display()))
}

fn edit_file(path: &Path, f: impl FnOnce(String) -> String) -> Result<(), String> {
    let s = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    fs::write(path, f(s)).map_err(|e| format!("write {}: {e}", path.display()))
}

// ---- engine / SDK vendoring -------------------------------------------------

fn vendor_engine(elpa_root: &Path, templates: &Path, dest_engine: &Path, v: &Vars) -> Result<(), String> {
    for crate_name in ENGINE_CRATES {
        let src = elpa_root.join("rust").join("crates").join(crate_name);
        copy_dir(&src, &dest_engine.join(crate_name), &[]).map_err(|e| format!("vendor crate {crate_name}: {e}"))?;
    }
    emit_template(templates, "_engine/Cargo.toml", &dest_engine.join("Cargo.toml"), v)
}

fn copy_sdk(elpa_root: &Path, example: &str, dst: &Path) -> Result<(), String> {
    let src = elpa_root.join("rust").join("examples").join(example).join("assets").join("sdk");
    copy_dir(&src, dst, &[]).map_err(|e| format!("copy {example} SDK: {e}"))
}

// ---- generators -------------------------------------------------------------

fn generate_wgpu(elpa_root: &Path, templates: &Path, dest: &Path, v: &Vars) -> Result<(), String> {
    vendor_engine(elpa_root, templates, &dest.join("engine"), v)?;

    // The SDKs are linked ahead of the app as plain VM-subset JS.
    copy_sdk(elpa_root, "game3d", &dest.join("app/sdk/game3d"))?;
    copy_sdk(elpa_root, "material", &dest.join("app/sdk/material"))?;

    // Project config.
    emit_template(templates, "wgpu/elpa.json", &dest.join("elpa.json"), v)?;
    emit_template(templates, "wgpu/tsconfig.json", &dest.join("tsconfig.json"), v)?;
    emit_template(templates, "wgpu/package.json", &dest.join("package.json"), v)?;
    emit_template(templates, "wgpu/README.md", &dest.join("README.md"), v)?;
    emit_template(templates, "wgpu/gitignore", &dest.join(".gitignore"), v)?;

    // The native host.
    emit_template(templates, "wgpu/app/Cargo.toml", &dest.join("app/Cargo.toml"), v)?;
    emit_template(templates, "wgpu/app/src/main.rs", &dest.join("app/src/main.rs"), v)?;

    // The TypeScript app (one component per file).
    for ts in ["elpa.d.ts", "theme.ts", "sim.ts", "scene.ts", "hud.ts", "main.ts"] {
        emit_template(templates, &format!("wgpu/app/ts/{ts}"), &dest.join("app/ts").join(ts), v)?;
    }
    Ok(())
}

/// Shared Flutter scaffolding for both flutter and wgpu-flutter templates.
fn scaffold_flutter(
    elpa_root: &Path,
    templates: &Path,
    dest: &Path,
    v: &Vars,
    ts_dir: &str,
    ts_files: &[&str],
    readme_template: &str,
) -> Result<(), String> {
    copy_dir(
        &elpa_root.join("flutter"),
        dest,
        &["android", "ios", "linux", "macos", "windows", "web"],
    )
    .map_err(|e| format!("copy flutter app: {e}"))?;

    vendor_engine(elpa_root, templates, &dest.join("engine"), v)?;
    edit_file(&dest.join("rust/Cargo.toml"), |s| s.replace("../../rust/crates/", "../engine/"))?;

    edit_file(&dest.join("pubspec.yaml"), |s| {
        s.lines()
            .map(|line| if line.starts_with("name:") { format!("name: {}", v.snake) } else { line.to_string() })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    })?;

    // Replace the single bundled `assets/app/main.js` with a multi-file TS app
    // whose build output lands back at that same path the Dart side loads.
    let _ = fs::remove_file(dest.join("assets/app/main.js"));
    for ts in ts_files {
        emit_template(templates, &format!("{ts_dir}/{ts}"), &dest.join("assets/app/ts").join(ts), v)?;
    }
    // Per-template config (elpa.json's `template` + the README differ); the
    // tsconfig / package.json / e2e test are shared from the flutter template.
    let base = ts_dir.trim_end_matches("/ts");
    emit_template(templates, &format!("{base}/elpa.json"), &dest.join("elpa.json"), v)?;
    emit_template(templates, "flutter/tsconfig.json", &dest.join("tsconfig.json"), v)?;
    emit_template(templates, "flutter/package.json", &dest.join("package.json"), v)?;
    emit_template(templates, "flutter/demo_app.rs", &dest.join("rust/tests/demo_app.rs"), v)?;
    emit_template(templates, readme_template, &dest.join("README.md"), v)
}

fn generate(template: &str, elpa_root: &Path, templates: &Path, dest: &Path, v: &Vars) -> Result<(), String> {
    match template {
        "wgpu" => generate_wgpu(elpa_root, templates, dest, v),
        "flutter" => scaffold_flutter(
            elpa_root,
            templates,
            dest,
            v,
            "flutter/ts",
            &["elpa.d.ts", "app.ts", "ui.ts", "cards.ts", "page.ts", "main.ts"],
            "flutter/README.md",
        ),
        "wgpu-flutter" => scaffold_flutter(
            elpa_root,
            templates,
            dest,
            v,
            "wgpu-flutter/ts",
            &["elpa.d.ts", "app.ts", "ui.ts", "scene.ts", "cards.ts", "page.ts", "main.ts"],
            "wgpu-flutter/README.md",
        ),
        other => Err(format!("unknown template \"{other}\"")),
    }
}

// ---- repo / template location ----------------------------------------------

pub fn find_elpa_root(explicit: Option<&str>) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = explicit {
        candidates.push(PathBuf::from(p));
    }
    candidates.push(PathBuf::from(DEFAULT_ELPA_ROOT));
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd);
        while let Some(d) = dir {
            candidates.push(d.clone());
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    for c in candidates {
        if c.join("rust/crates/elpa/Cargo.toml").is_file() && c.join("flutter/pubspec.yaml").is_file() {
            return Ok(fs::canonicalize(&c).unwrap_or(c));
        }
    }
    Err("could not locate the Elpa repository. Pass --elpa-root <path> pointing at \
         the checkout that contains rust/crates/elpa and flutter/."
        .to_string())
}

// ---- argument parsing / interactive prompt ----------------------------------

struct Opts {
    name: Option<String>,
    template: Option<String>,
    dir: Option<String>,
    elpa_root: Option<String>,
    force: bool,
}

fn parse_args(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts { name: None, template: None, dir: None, elpa_root: None, force: false };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "-t" | "--template" => {
                i += 1;
                o.template = Some(args.get(i).ok_or("--template needs a value")?.clone());
            }
            "--dir" => {
                i += 1;
                o.dir = Some(args.get(i).ok_or("--dir needs a value")?.clone());
            }
            "--elpa-root" => {
                i += 1;
                o.elpa_root = Some(args.get(i).ok_or("--elpa-root needs a value")?.clone());
            }
            "--force" => o.force = true,
            _ if a.starts_with("--template=") => o.template = Some(a["--template=".len()..].to_string()),
            _ if a.starts_with('-') => return Err(format!("unknown option: {a}")),
            _ if o.name.is_none() => o.name = Some(a.clone()),
            _ => return Err(format!("unexpected argument: {a}")),
        }
        i += 1;
    }
    Ok(o)
}

fn prompt_line(question: &str) -> String {
    print!("{question}");
    let _ = io::stdout().flush();
    let mut line = String::new();
    match io::stdin().read_line(&mut line) {
        Ok(0) | Err(_) => String::new(),
        Ok(_) => line.trim().to_string(),
    }
}

fn interactive(o: &mut Opts) -> Result<(), String> {
    if o.name.is_none() {
        let n = prompt_line("Project name: ");
        if n.is_empty() {
            return Err("a project name is required".to_string());
        }
        o.name = Some(n);
    }
    if o.template.is_none() {
        println!("\nTemplate:");
        for (idx, (_, label)) in TEMPLATES.iter().enumerate() {
            println!("  {}) {label}", idx + 1);
        }
        let ans = prompt_line(&format!("Choose [1-{}]: ", TEMPLATES.len()));
        let chosen = ans
            .parse::<usize>()
            .ok()
            .and_then(|n| TEMPLATES.get(n.wrapping_sub(1)))
            .map(|(k, _)| k.to_string())
            .or_else(|| TEMPLATES.iter().find(|(k, _)| *k == ans).map(|(k, _)| k.to_string()));
        match chosen {
            Some(t) => o.template = Some(t),
            None => return Err("invalid template selection".to_string()),
        }
    }
    Ok(())
}

// ---- entry ------------------------------------------------------------------

pub fn run_init(args: &[String]) -> Result<(), String> {
    let mut opts = parse_args(args)?;
    if opts.name.is_none() || opts.template.is_none() {
        interactive(&mut opts)?;
    }
    let name = opts.name.clone().ok_or("a project name is required")?;
    let template = opts.template.clone().ok_or("a template is required")?;
    if !TEMPLATES.iter().any(|(k, _)| *k == template) {
        let names: Vec<&str> = TEMPLATES.iter().map(|(k, _)| *k).collect();
        return Err(format!("unknown template \"{template}\". Choose one of: {}", names.join(", ")));
    }

    let vars = Vars { snake: snake_case(&name), title: title_case(&name), name };
    let dest = PathBuf::from(opts.dir.clone().unwrap_or_else(|| vars.snake.clone()));
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) && !opts.force {
        return Err(format!(
            "directory {} already exists and is not empty (use --force to override)",
            dest.display()
        ));
    }

    let elpa_root = find_elpa_root(opts.elpa_root.as_deref())?;
    let templates = PathBuf::from(TEMPLATES_DIR);
    if !templates.is_dir() {
        return Err(format!("templates not found at {}", templates.display()));
    }

    println!("\nCreating {template} project \"{}\"", vars.name);
    println!("  output: {}", dest.display());
    println!("  engine: {}\n", elpa_root.display());

    fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    generate(&template, &elpa_root, &templates, &dest, &vars)?;

    // Produce the initial bundle + bytecode so the project runs immediately.
    println!("Building initial bundle…");
    let m = Manifest::find(&dest)?;
    builder::build(&m, false)?;

    println!("\x1b[32m✓\x1b[0m Project ready at {}", dest.display());
    print_next_steps(&template, &dest);
    Ok(())
}

fn print_next_steps(template: &str, dest: &Path) {
    let rel = dest.display().to_string();
    println!("\nNext steps:");
    if template == "wgpu" {
        println!("  cd {rel}");
        println!("  create-elpa-app build           # re-bundle app/ts → app/dist after edits");
        println!("  (cd app && cargo run --release) # opens a window with the 3D + 2D demo");
    } else {
        let pkg = dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        println!("  cd {rel}");
        println!("  create-elpa-app build           # bundle assets/app/ts → assets/app/main.js");
        println!("  flutter create . --platforms=android,ios,linux,macos,windows,web --project-name {pkg}");
        println!("  flutter_rust_bridge_codegen generate && flutter pub get && flutter run");
        println!("  create-elpa-app install && create-elpa-app dev   # build+serve the wasm host");
    }
    println!("\nSee the generated README.md for the full walkthrough.");
}
