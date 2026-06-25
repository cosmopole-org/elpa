//! `install` — one-shot environment bootstrap for Elpa development.
//!
//! Prepares a machine to build every template end-to-end: the Rust wasm target,
//! the Rust CLI tools (`wasm-bindgen`, `flutter_rust_bridge_codegen`), the system
//! build dependencies, and the **Flutter SDK** — then builds the default Elpa +
//! Flutter **wasm host** that `dev` serves.
//!
//! Every stage is **idempotent**: anything already present is detected and
//! skipped, so re-running is cheap. `--dry-run` prints the plan without touching
//! the machine; `--skip-host` installs the toolchains but leaves the (heavy) wasm
//! host build for later.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct InstallOpts {
    pub force: bool,
    pub dry_run: bool,
    pub skip_host: bool,
}

/// Shared cache location for the prebuilt wasm host's web root.
pub fn host_dir() -> PathBuf {
    cache_base().join("elpa").join("web-host")
}

fn cache_base() -> PathBuf {
    std::env::var("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".cache")
    })
}

/// Where the Flutter SDK is installed when the machine doesn't already have it.
fn flutter_home() -> PathBuf {
    cache_base().join("elpa").join("toolchains").join("flutter")
}

pub fn install(elpa_root: &Path, opts: InstallOpts) -> Result<(), String> {
    let mut ix = Installer::new(opts);
    println!("\x1b[1mElpa environment setup\x1b[0m  ({})", platform());
    if ix.opts.dry_run {
        println!("(dry run — nothing will be installed)\n");
    }

    ix.ensure_rust()?;
    ix.ensure_wasm_target()?;
    ix.ensure_system_deps()?;
    ix.ensure_cargo_tool("wasm-bindgen", "wasm-bindgen-cli")?;
    ix.ensure_cargo_tool("flutter_rust_bridge_codegen", "flutter_rust_bridge_codegen")?;
    ix.ensure_flutter()?;

    if ix.opts.skip_host {
        println!("\n\x1b[33m•\x1b[0m skipping wasm host build (--skip-host)");
    } else {
        ix.build_host(elpa_root)?;
    }

    ix.summary();
    Ok(())
}

struct Installer {
    opts: InstallOpts,
    /// Extra directories prepended to `PATH` for child commands (cargo bin,
    /// Flutter bin) so freshly installed tools are visible without a new shell.
    extra_paths: Vec<PathBuf>,
    installed: Vec<String>,
    notes: Vec<String>,
}

impl Installer {
    fn new(opts: InstallOpts) -> Self {
        let mut extra_paths = vec![];
        if let Ok(home) = std::env::var("HOME") {
            extra_paths.push(PathBuf::from(&home).join(".cargo").join("bin"));
        }
        Installer { opts, extra_paths, installed: vec![], notes: vec![] }
    }

    // ---- stage: Rust toolchain ---------------------------------------------
    fn ensure_rust(&mut self) -> Result<(), String> {
        self.step("Rust toolchain");
        if have("cargo", &["--version"]) && have("rustup", &["--version"]) {
            return self.ok_present("rustup + cargo");
        }
        if !have("curl", &["--version"]) {
            return Err("rustup is missing and `curl` is unavailable to install it. \
                        Install Rust from https://rustup.rs and re-run."
                .into());
        }
        // Official non-interactive rustup install (adds ~/.cargo/bin, already on
        // our child PATH via `extra_paths`).
        self.run_shell(
            "install rustup",
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path",
        )?;
        self.installed.push("rustup + cargo".into());
        self.notes.push("add `$HOME/.cargo/bin` to your shell PATH".into());
        Ok(())
    }

    // ---- stage: wasm target -------------------------------------------------
    fn ensure_wasm_target(&mut self) -> Result<(), String> {
        self.step("Rust wasm target (wasm32-unknown-unknown)");
        let present = Command::new("rustup")
            .args(["target", "list", "--installed"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("wasm32-unknown-unknown"))
            .unwrap_or(false);
        if present && !self.opts.force {
            return self.ok_present("wasm32-unknown-unknown");
        }
        self.run("add wasm target", None, "rustup", &["target", "add", "wasm32-unknown-unknown"])?;
        self.installed.push("wasm32-unknown-unknown target".into());
        Ok(())
    }

    // ---- stage: Rust CLI tools ---------------------------------------------
    fn ensure_cargo_tool(&mut self, bin: &str, krate: &str) -> Result<(), String> {
        self.step(&format!("Rust tool: {bin}"));
        if have(bin, &["--version"]) && !self.opts.force {
            return self.ok_present(bin);
        }
        self.run("cargo install", None, "cargo", &["install", "--locked", krate])?;
        self.installed.push(bin.into());
        Ok(())
    }

    // ---- stage: system build dependencies ----------------------------------
    fn ensure_system_deps(&mut self) -> Result<(), String> {
        self.step("System build dependencies");
        let Some(pm) = detect_pkg_manager() else {
            self.notes.push("no supported package manager found — install git/clang/cmake/ninja/pkg-config manually".into());
            println!("  • no apt/dnf/pacman/zypper/brew detected; skipping (install build tools manually)");
            return Ok(());
        };
        // Package managers no-op already-installed packages, so this is idempotent.
        let sudo = needs_sudo(&pm.bin);
        if let Some(update) = &pm.update {
            let _ = self.run_pm("refresh package index", sudo, &pm.bin, update); // best-effort
        }
        let mut args = pm.install.clone();
        args.extend(pm.packages.iter().map(|s| s.to_string()));
        // Best-effort: a failure here (locked apt, offline mirror) shouldn't abort
        // the toolchain install — report and continue.
        match self.run_pm("install build deps", sudo, &pm.bin, &args) {
            Ok(()) => self.installed.push(format!("system deps via {}", pm.bin)),
            Err(e) => {
                println!("  \x1b[33m•\x1b[0m system deps not fully installed: {e}");
                self.notes.push(format!("re-run system deps via {} if a later step needs them", pm.bin));
            }
        }
        Ok(())
    }

    // ---- stage: Flutter SDK -------------------------------------------------
    fn ensure_flutter(&mut self) -> Result<(), String> {
        self.step("Flutter SDK");
        if have("flutter", &["--version"]) && !self.opts.force {
            return self.ok_present("flutter (already on PATH)");
        }
        let home = flutter_home();
        if !home.join("bin").join(flutter_bin()).exists() {
            if let Some(parent) = home.parent() {
                if !self.opts.dry_run {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            // A shallow clone of the stable channel keeps the download small.
            self.run(
                "clone Flutter (stable)",
                None,
                "git",
                &["clone", "--depth", "1", "-b", "stable", "https://github.com/flutter/flutter.git", &home.display().to_string()],
            )?;
        } else {
            println!("  • Flutter already cloned at {}", home.display());
        }
        // Make this and later commands see the just-cloned SDK.
        self.extra_paths.push(home.join("bin"));
        // Prefetch the web engine artifacts and enable the web target.
        self.run("flutter precache (web)", None, "flutter", &["precache", "--web", "--universal"])?;
        self.run("enable web", None, "flutter", &["config", "--enable-web"])?;
        self.installed.push(format!("Flutter SDK ({})", home.display()));
        self.notes.push(format!("add `{}/bin` to your shell PATH", home.display()));
        Ok(())
    }

    // ---- stage: build the wasm host ----------------------------------------
    fn build_host(&mut self, elpa_root: &Path) -> Result<(), String> {
        self.step("Build the Elpa + Flutter wasm host");
        let host = host_dir();
        if host.join("index.html").is_file() && !self.opts.force {
            println!("  • already built at {} (use --force to rebuild)", host.display());
            return Ok(());
        }
        let project = elpa_root.join("flutter");
        if !project.join("pubspec.yaml").is_file() {
            return Err(format!("Flutter host project not found at {}", project.display()));
        }
        self.run("flutter pub get", Some(&project), "flutter", &["pub", "get"])?;
        self.run("flutter_rust_bridge_codegen generate", Some(&project), "flutter_rust_bridge_codegen", &["generate"])?;
        self.run("flutter build web --wasm", Some(&project), "flutter", &["build", "web", "--wasm", "--release"])?;

        if self.opts.dry_run {
            return Ok(());
        }
        let web = project.join("build").join("web");
        if !web.join("index.html").is_file() {
            return Err(format!("expected Flutter web build at {} but it is missing", web.display()));
        }
        if host.exists() {
            let _ = std::fs::remove_dir_all(&host);
        }
        std::fs::create_dir_all(host.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::scaffold::copy_tree(&web, &host).map_err(|e| format!("publish host: {e}"))?;
        self.installed.push(format!("wasm host ({})", host.display()));
        Ok(())
    }

    fn summary(&self) {
        println!("\n\x1b[32m✓\x1b[0m Environment ready.");
        if self.installed.is_empty() {
            println!("  Everything was already present — nothing to do.");
        } else {
            println!("  Installed / built:");
            for i in &self.installed {
                println!("    • {i}");
            }
        }
        if !self.notes.is_empty() {
            println!("  Notes:");
            for n in &self.notes {
                println!("    • {n}");
            }
        }
        if !self.opts.skip_host {
            println!("\n  Next: `create-elpa-app dev` builds your project and serves it on the host.");
        }
    }

    // ---- helpers ------------------------------------------------------------
    fn step(&self, label: &str) {
        println!("\n\x1b[1m==>\x1b[0m {label}");
    }

    fn ok_present(&self, what: &str) -> Result<(), String> {
        println!("  • {what} already present — skipping");
        Ok(())
    }

    /// `PATH` for child processes: our extra dirs prepended to the inherited one.
    fn child_path(&self) -> String {
        let mut parts: Vec<String> = self.extra_paths.iter().map(|p| p.display().to_string()).collect();
        if let Ok(existing) = std::env::var("PATH") {
            parts.push(existing);
        }
        parts.join(":")
    }

    fn run(&self, label: &str, dir: Option<&Path>, bin: &str, args: &[&str]) -> Result<(), String> {
        println!("  $ {bin} {}", args.join(" "));
        if self.opts.dry_run {
            return Ok(());
        }
        let mut cmd = Command::new(bin);
        cmd.args(args).env("PATH", self.child_path());
        if let Some(d) = dir {
            cmd.current_dir(d);
        }
        let status = cmd.status().map_err(|e| format!("spawn {bin}: {e} ({label})"))?;
        if !status.success() {
            return Err(format!("`{bin} {}` failed ({status})", args.join(" ")));
        }
        Ok(())
    }

    fn run_pm(&self, label: &str, sudo: bool, bin: &str, args: &[String]) -> Result<(), String> {
        let (real_bin, real_args): (&str, Vec<&str>) = if sudo {
            let mut v = vec![bin];
            v.extend(args.iter().map(|s| s.as_str()));
            ("sudo", v)
        } else {
            (bin, args.iter().map(|s| s.as_str()).collect())
        };
        self.run(label, None, real_bin, &real_args)
    }

    fn run_shell(&self, label: &str, script: &str) -> Result<(), String> {
        println!("  $ {script}");
        if self.opts.dry_run {
            return Ok(());
        }
        let status = Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("PATH", self.child_path())
            .status()
            .map_err(|e| format!("spawn sh: {e} ({label})"))?;
        if !status.success() {
            return Err(format!("`{label}` failed ({status})"));
        }
        Ok(())
    }
}

// ---- platform / package-manager detection -----------------------------------

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Linux"
    }
}

fn flutter_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "flutter.bat"
    } else {
        "flutter"
    }
}

/// True if a tool responds to a probe (i.e. is installed and on PATH).
fn have(bin: &str, probe: &[&str]) -> bool {
    Command::new(bin)
        .args(probe)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether to prefix a package-manager call with `sudo` (non-root + sudo exists).
fn needs_sudo(_pm_bin: &str) -> bool {
    if cfg!(target_os = "macos") {
        return false; // brew refuses to run under sudo
    }
    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false);
    !is_root && have("sudo", &["-n", "true"])
}

struct Pm {
    bin: String,
    update: Option<Vec<String>>,
    install: Vec<String>,
    packages: Vec<&'static str>,
}

fn detect_pkg_manager() -> Option<Pm> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if have("apt-get", &["--version"]) {
        Some(Pm {
            bin: "apt-get".into(),
            update: Some(s(&["update"])),
            install: s(&["install", "-y"]),
            packages: vec![
                "git", "curl", "unzip", "xz-utils", "zip", "clang", "cmake", "ninja-build",
                "pkg-config", "libgtk-3-dev", "liblzma-dev", "build-essential",
            ],
        })
    } else if have("dnf", &["--version"]) {
        Some(Pm {
            bin: "dnf".into(),
            update: None,
            install: s(&["install", "-y"]),
            packages: vec![
                "git", "curl", "unzip", "xz", "zip", "clang", "cmake", "ninja-build",
                "pkgconf-pkg-config", "gtk3-devel", "xz-devel", "gcc", "gcc-c++",
            ],
        })
    } else if have("pacman", &["--version"]) {
        Some(Pm {
            bin: "pacman".into(),
            update: None,
            install: s(&["-S", "--needed", "--noconfirm"]),
            packages: vec!["git", "curl", "unzip", "xz", "zip", "clang", "cmake", "ninja", "pkgconf", "gtk3", "base-devel"],
        })
    } else if have("zypper", &["--version"]) {
        Some(Pm {
            bin: "zypper".into(),
            update: None,
            install: s(&["install", "-y"]),
            packages: vec!["git", "curl", "unzip", "xz", "zip", "clang", "cmake", "ninja", "pkg-config", "gtk3-devel", "gcc", "gcc-c++"],
        })
    } else if have("brew", &["--version"]) {
        Some(Pm {
            bin: "brew".into(),
            update: None,
            install: s(&["install"]),
            packages: vec!["git", "unzip", "cmake", "ninja", "pkg-config"],
        })
    } else {
        None
    }
}
