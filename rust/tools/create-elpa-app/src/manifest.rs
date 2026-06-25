//! The `elpa.json` project manifest that `build` / `dev` read.

use std::path::{Path, PathBuf};

/// A loaded `elpa.json`, with paths resolved against the project root.
pub struct Manifest {
    pub root: PathBuf,
    pub name: String,
    pub template: String,
    /// TypeScript entry file (the bundler's root).
    pub entry: PathBuf,
    /// Vendored SDK directories whose `.js` modules are prepended (lexically
    /// sorted) ahead of the transpiled app.
    pub sdk: Vec<PathBuf>,
    /// Output directory for `app.js` (the bundle) and `app.bc` (the bytecode).
    pub out_dir: PathBuf,
    /// Optional extra output: the prelude + transpiled app (no SDK), written here
    /// for hosts that load the SDK modules separately (the Flutter Dart loader
    /// concatenates `sdk/*.js` + this file at runtime).
    pub app_out: Option<PathBuf>,
}

impl Manifest {
    /// Find and parse `elpa.json` by walking up from `start`.
    pub fn find(start: &Path) -> Result<Manifest, String> {
        let mut dir = Some(start.to_path_buf());
        while let Some(d) = dir {
            let candidate = d.join("elpa.json");
            if candidate.is_file() {
                return Manifest::load(&candidate);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        Err("no elpa.json found in this directory or any parent (is this an Elpa project?)".into())
    }

    fn load(path: &Path) -> Result<Manifest, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
        let root = path.parent().unwrap_or(Path::new(".")).to_path_buf();

        let s = |key: &str| -> Result<String, String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(|x| x.to_string())
                .ok_or_else(|| format!("elpa.json: missing string field \"{key}\""))
        };
        let sdk = v
            .get("sdk")
            .and_then(|x| x.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str()).map(|x| root.join(x)).collect())
            .unwrap_or_default();

        let app_out = v.get("appOut").and_then(|x| x.as_str()).map(|x| root.join(x));

        Ok(Manifest {
            name: s("name")?,
            template: s("template")?,
            entry: root.join(s("entry")?),
            out_dir: root.join(s("outDir")?),
            app_out,
            sdk,
            root,
        })
    }
}
