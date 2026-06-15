//! Host-side environmental interfaces: the fabricated filesystem, networking,
//! the clock, and randomness — the concrete implementations behind the VM's
//! capability-gated `fs.*`, `net.*`, `time.*`, and `random.*` host calls.
//!
//! The VM never touches the operating system directly. It emits an `askHost`
//! request and pauses; the embedder routes it here. This module is where those
//! requests become real effects, and crucially it is **togglable and bounded**:
//!
//! * Every interface family has an on/off switch ([`EnvToggles`]) the host can
//!   flip at any time. A disabled family answers with a typed error reply
//!   instead of performing the effect — a second line of defense behind the
//!   VM-level capability gate (which short-circuits before the call even
//!   reaches the host).
//! * The fabricated filesystem is an abstraction ([`FileStore`]) with two
//!   bundled backends: [`NativeFileStore`], which maps a virtual path tree onto
//!   a real sandbox directory on native targets, and [`MemoryFileStore`], the
//!   in-memory store that stands in for browser storage on the web. The guest
//!   sees the *same* virtual filesystem either way.
//! * Storage is bounded: the store enforces a byte cap, so a guest cannot fill
//!   the host disk (or browser quota).
//! * Networking is a pluggable [`NetProvider`]; the default denies all traffic,
//!   so a guest has no network until the host explicitly grants one.
//!
//! Payloads follow the VM's `askHost` convention: arguments arrive wrapped in a
//! JSON array (`[arg0, …]`); these helpers unwrap the first argument. Replies
//! are JSON objects with an `ok` flag plus result fields, so guest code can
//! branch on success without exceptions.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use elpa_protocol::HostCall;
use serde_json::{json, Value};

/// On/off switches for each environmental interface family. The host owns this
/// and may flip any switch between turns to grant or revoke an interface.
#[derive(Clone, Copy, Debug)]
pub struct EnvToggles {
    pub filesystem: bool,
    pub network: bool,
    pub clock: bool,
    pub randomness: bool,
}

impl Default for EnvToggles {
    fn default() -> Self {
        // Storage and clock are safe, deterministic-enough defaults; network and
        // randomness start off and are granted explicitly.
        EnvToggles { filesystem: true, network: false, clock: true, randomness: false }
    }
}

impl EnvToggles {
    /// Everything off — a fully isolated guest.
    pub fn all_off() -> Self {
        EnvToggles { filesystem: false, network: false, clock: false, randomness: false }
    }
    /// Everything on — a fully trusted guest.
    pub fn all_on() -> Self {
        EnvToggles { filesystem: true, network: true, clock: true, randomness: true }
    }
}

/// Metadata about a stored file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
}

/// The fabricated filesystem abstraction. Paths are *virtual* and POSIX-like
/// (`/a/b.txt`); a backend maps them to its medium. Every method is fallible and
/// returns a human-readable error string on failure.
pub trait FileStore {
    fn read(&self, path: &str) -> Result<Vec<u8>, String>;
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
    fn append(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
    fn delete(&mut self, path: &str) -> Result<(), String>;
    fn exists(&self, path: &str) -> bool;
    fn list(&self, path: &str) -> Result<Vec<String>, String>;
    fn stat(&self, path: &str) -> Result<FileStat, String>;
    fn mkdir(&mut self, path: &str) -> Result<(), String>;
    /// Total bytes currently stored (for storage accounting).
    fn used_bytes(&self) -> u64;
}

/// Normalize a virtual path into clean `/`-separated components, rejecting any
/// `..` escape. Returns the components (no leading slash) or an error.
fn normalize(path: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("path escapes the filesystem root".to_string()),
            seg => out.push(seg.to_string()),
        }
    }
    Ok(out)
}

fn join_virtual(parts: &[String]) -> String {
    format!("/{}", parts.join("/"))
}

// ---- In-memory backend (browser-storage analog) ----------------------------

/// An in-memory filesystem. This is the web build target's backend (it stands in
/// for browser storage such as IndexedDB / localStorage) and the default for
/// tests and headless hosts. Bounded by an optional byte cap.
#[derive(Debug, Default)]
pub struct MemoryFileStore {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeMap<String, ()>,
    cap: Option<u64>,
}

impl MemoryFileStore {
    pub fn new() -> Self {
        let mut dirs = BTreeMap::new();
        dirs.insert("/".to_string(), ());
        MemoryFileStore { files: BTreeMap::new(), dirs, cap: None }
    }
    /// Cap total stored bytes; writes that would exceed it fail.
    pub fn with_capacity(cap: u64) -> Self {
        let mut s = Self::new();
        s.cap = Some(cap);
        s
    }
    fn key(path: &str) -> Result<String, String> {
        Ok(join_virtual(&normalize(path)?))
    }
    fn check_cap(&self, added: u64, replacing: u64) -> Result<(), String> {
        if let Some(cap) = self.cap {
            let next = self.used_bytes().saturating_sub(replacing).saturating_add(added);
            if next > cap {
                return Err(format!("storage limit exceeded ({next} > {cap} bytes)"));
            }
        }
        Ok(())
    }
}

impl FileStore for MemoryFileStore {
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let k = Self::key(path)?;
        self.files.get(&k).cloned().ok_or_else(|| format!("no such file: {k}"))
    }
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        let k = Self::key(path)?;
        let prev = self.files.get(&k).map(|v| v.len() as u64).unwrap_or(0);
        self.check_cap(data.len() as u64, prev)?;
        self.files.insert(k, data.to_vec());
        Ok(())
    }
    fn append(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        let k = Self::key(path)?;
        self.check_cap(data.len() as u64, 0)?;
        self.files.entry(k).or_default().extend_from_slice(data);
        Ok(())
    }
    fn delete(&mut self, path: &str) -> Result<(), String> {
        let k = Self::key(path)?;
        if self.files.remove(&k).is_some() {
            Ok(())
        } else {
            Err(format!("no such file: {k}"))
        }
    }
    fn exists(&self, path: &str) -> bool {
        match Self::key(path) {
            Ok(k) => self.files.contains_key(&k) || self.dirs.contains_key(&k),
            Err(_) => false,
        }
    }
    fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let parts = normalize(path)?;
        let prefix = join_virtual(&parts);
        let prefix = if prefix == "/" { "/".to_string() } else { format!("{prefix}/") };
        let mut out = std::collections::BTreeSet::new();
        for key in self.files.keys() {
            if let Some(rest) = key.strip_prefix(&prefix) {
                if let Some(first) = rest.split('/').next() {
                    if !first.is_empty() {
                        out.insert(first.to_string());
                    }
                }
            }
        }
        Ok(out.into_iter().collect())
    }
    fn stat(&self, path: &str) -> Result<FileStat, String> {
        let k = Self::key(path)?;
        if let Some(v) = self.files.get(&k) {
            Ok(FileStat { size: v.len() as u64, is_dir: false })
        } else if self.dirs.contains_key(&k) {
            Ok(FileStat { size: 0, is_dir: true })
        } else {
            Err(format!("no such path: {k}"))
        }
    }
    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        let k = Self::key(path)?;
        self.dirs.insert(k, ());
        Ok(())
    }
    fn used_bytes(&self) -> u64 {
        self.files.values().map(|v| v.len() as u64).sum()
    }
}

// ---- Native backend (real disk, sandboxed) ---------------------------------

/// A filesystem backed by a real directory tree on a native target. Virtual
/// paths are mapped beneath `root`; `..` escapes are rejected so a guest can
/// never reach outside its sandbox. Bounded by an optional byte cap.
#[derive(Debug)]
pub struct NativeFileStore {
    root: PathBuf,
    cap: Option<u64>,
}

impl NativeFileStore {
    /// Create (and ensure) a sandbox rooted at `root`.
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(NativeFileStore { root, cap: None })
    }
    pub fn with_capacity(root: impl Into<PathBuf>, cap: u64) -> std::io::Result<Self> {
        let mut s = Self::new(root)?;
        s.cap = Some(cap);
        Ok(s)
    }
    fn real(&self, path: &str) -> Result<PathBuf, String> {
        let parts = normalize(path)?;
        let mut p = self.root.clone();
        for seg in parts {
            p.push(seg);
        }
        // Defense in depth: confirm the resolved path stays under root even if a
        // symlink or odd component slipped through normalization.
        if !under_root(&self.root, &p) {
            return Err("path escapes the filesystem root".to_string());
        }
        Ok(p)
    }
    fn dir_size(dir: &Path) -> u64 {
        let mut total = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    total += Self::dir_size(&p);
                } else if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
        total
    }
    fn check_cap(&self, added: u64, replacing: u64) -> Result<(), String> {
        if let Some(cap) = self.cap {
            let next = self.used_bytes().saturating_sub(replacing).saturating_add(added);
            if next > cap {
                return Err(format!("storage limit exceeded ({next} > {cap} bytes)"));
            }
        }
        Ok(())
    }
}

/// Whether `candidate` is lexically contained in `root` (no `..` traversal).
fn under_root(root: &Path, candidate: &Path) -> bool {
    let mut depth = 0i64;
    let base = candidate.strip_prefix(root).unwrap_or(candidate);
    for c in base.components() {
        match c {
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

impl FileStore for NativeFileStore {
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(self.real(path)?).map_err(|e| e.to_string())
    }
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        let p = self.real(path)?;
        let prev = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        self.check_cap(data.len() as u64, prev)?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, data).map_err(|e| e.to_string())
    }
    fn append(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let p = self.real(path)?;
        self.check_cap(data.len() as u64, 0)?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())
    }
    fn delete(&mut self, path: &str) -> Result<(), String> {
        std::fs::remove_file(self.real(path)?).map_err(|e| e.to_string())
    }
    fn exists(&self, path: &str) -> bool {
        self.real(path).map(|p| p.exists()).unwrap_or(false)
    }
    fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let p = self.real(path)?;
        let mut out = Vec::new();
        for e in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            out.push(e.file_name().to_string_lossy().to_string());
        }
        out.sort();
        Ok(out)
    }
    fn stat(&self, path: &str) -> Result<FileStat, String> {
        let m = std::fs::metadata(self.real(path)?).map_err(|e| e.to_string())?;
        Ok(FileStat { size: m.len(), is_dir: m.is_dir() })
    }
    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        std::fs::create_dir_all(self.real(path)?).map_err(|e| e.to_string())
    }
    fn used_bytes(&self) -> u64 {
        Self::dir_size(&self.root)
    }
}

// ---- Networking ------------------------------------------------------------

/// A network request the guest asked the host to perform.
#[derive(Clone, Debug, Default)]
pub struct NetRequest {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
}

/// A network response handed back to the guest.
#[derive(Clone, Debug)]
pub struct NetResponse {
    pub status: u16,
    pub body: String,
}

/// Pluggable network provider. The host installs one to grant a guest network
/// access; the default ([`DeniedNet`]) refuses every request.
pub trait NetProvider {
    fn fetch(&mut self, req: &NetRequest) -> Result<NetResponse, String>;
}

/// The default provider: all networking denied.
#[derive(Debug, Default)]
pub struct DeniedNet;

impl NetProvider for DeniedNet {
    fn fetch(&mut self, _req: &NetRequest) -> Result<NetResponse, String> {
        Err("network access is not provisioned".to_string())
    }
}

/// A provider backed by a host-supplied closure (e.g. a synchronous fetch). Lets
/// an embedder wire real HTTP without this crate depending on an HTTP stack.
pub struct ClosureNet<F: FnMut(&NetRequest) -> Result<NetResponse, String>>(pub F);

impl<F: FnMut(&NetRequest) -> Result<NetResponse, String>> NetProvider for ClosureNet<F> {
    fn fetch(&mut self, req: &NetRequest) -> Result<NetResponse, String> {
        (self.0)(req)
    }
}

// ---- The unified host environment ------------------------------------------

/// The host-side service for all environmental interfaces. Construct one, wire
/// in the filesystem/network backends appropriate to the build target, and call
/// [`HostEnv::service`] from the embedder's host-call dispatcher.
pub struct HostEnv {
    toggles: EnvToggles,
    fs: Box<dyn FileStore>,
    net: Box<dyn NetProvider>,
    /// Monotonic counter standing in for a clock when none is wired (keeps the
    /// service usable and deterministic in tests); real hosts can override.
    clock_ms: u64,
    /// Deterministic PRNG state for `random.*` when randomness is enabled. A
    /// real host can reseed; this keeps the service self-contained and testable.
    rng_state: u64,
    /// Rasterised font atlases keyed by pixel size, so `text.atlas` builds each
    /// size once and replays the cached reply on subsequent calls.
    atlas_cache: BTreeMap<u32, String>,
}

/// Bundled UI font (Liberation Sans, SIL OFL 1.1 — see `assets/fonts/LICENSE.txt`).
/// A metric-compatible, professional sans-serif rasterised on the host into a
/// coverage atlas the SDK samples for real, anti-aliased text.
const FONT_REGULAR: &[u8] = include_bytes!("../assets/fonts/LiberationSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../assets/fonts/LiberationSans-Bold.ttf");

impl Default for HostEnv {
    fn default() -> Self {
        HostEnv::new(Box::new(MemoryFileStore::new()), Box::new(DeniedNet))
    }
}

impl HostEnv {
    pub fn new(fs: Box<dyn FileStore>, net: Box<dyn NetProvider>) -> Self {
        HostEnv { toggles: EnvToggles::default(), fs, net, clock_ms: 0, rng_state: 0x9E3779B97F4A7C15, atlas_cache: BTreeMap::new() }
    }

    pub fn toggles(&self) -> EnvToggles {
        self.toggles
    }
    pub fn set_toggles(&mut self, toggles: EnvToggles) {
        self.toggles = toggles;
    }
    /// Flip a single family on or off by its host-API prefix (`fs`, `net`,
    /// `time`, `random`).
    pub fn set_family(&mut self, family: &str, on: bool) {
        match family {
            "fs" => self.toggles.filesystem = on,
            "net" => self.toggles.network = on,
            "time" => self.toggles.clock = on,
            "random" => self.toggles.randomness = on,
            _ => {}
        }
    }
    pub fn fs(&self) -> &dyn FileStore {
        self.fs.as_ref()
    }
    pub fn fs_mut(&mut self) -> &mut dyn FileStore {
        self.fs.as_mut()
    }
    /// Replace the network provider (grant or revoke real connectivity).
    pub fn set_net(&mut self, net: Box<dyn NetProvider>) {
        self.net = net;
    }
    /// Advance the stand-in clock (a real host would not need this).
    pub fn tick(&mut self, ms: u64) {
        self.clock_ms = self.clock_ms.saturating_add(ms);
    }

    /// Service a host call if it targets an environmental interface this module
    /// owns (`fs.*`, `net.*`, `time.*`, `random.*`). Returns `Some(reply_json)`
    /// when handled, or `None` so the embedder can fall through to its own
    /// handlers (GPU, log, import, …).
    pub fn service(&mut self, call: &HostCall) -> Option<String> {
        let family = call.api_name.split('.').next().unwrap_or("");
        match family {
            "fs" => Some(self.service_fs(call)),
            "net" => Some(self.service_net(call)),
            "time" => Some(self.service_time(call)),
            "random" => Some(self.service_random(call)),
            "text" => Some(self.service_text(call)),
            _ => None,
        }
    }

    fn service_fs(&mut self, call: &HostCall) -> String {
        if !self.toggles.filesystem {
            return err_reply("filesystem interface disabled");
        }
        let arg = first_arg(&call.payload).unwrap_or(Value::Null);
        match call.api_name.as_str() {
            "fs.read" => match self.fs.read(&str_field(&arg, "path").unwrap_or_default()) {
                Ok(bytes) => json!({ "ok": true, "data": String::from_utf8_lossy(&bytes) }).to_string(),
                Err(e) => err_reply(&e),
            },
            "fs.write" => {
                let path = obj_str(&arg, "path");
                let data = obj_str(&arg, "data");
                result_reply(self.fs.write(&path, data.as_bytes()))
            }
            "fs.append" => {
                let path = obj_str(&arg, "path");
                let data = obj_str(&arg, "data");
                result_reply(self.fs.append(&path, data.as_bytes()))
            }
            "fs.delete" => result_reply(self.fs.delete(&str_or(&arg))),
            "fs.exists" => json!({ "ok": true, "exists": self.fs.exists(&str_or(&arg)) }).to_string(),
            "fs.list" => match self.fs.list(&str_or(&arg)) {
                Ok(entries) => json!({ "ok": true, "entries": entries }).to_string(),
                Err(e) => err_reply(&e),
            },
            "fs.stat" => match self.fs.stat(&str_or(&arg)) {
                Ok(s) => json!({ "ok": true, "size": s.size, "isDir": s.is_dir }).to_string(),
                Err(e) => err_reply(&e),
            },
            "fs.mkdir" => result_reply(self.fs.mkdir(&str_or(&arg))),
            other => err_reply(&format!("unknown fs api: {other}")),
        }
    }

    fn service_net(&mut self, call: &HostCall) -> String {
        if !self.toggles.network {
            return err_reply("network interface disabled");
        }
        let arg = first_arg(&call.payload).unwrap_or(Value::Null);
        match call.api_name.as_str() {
            "net.fetch" => {
                let req = NetRequest {
                    method: str_field(&arg, "method").unwrap_or_else(|| "GET".to_string()),
                    url: str_field(&arg, "url").unwrap_or_else(|| str_or(&arg)),
                    body: str_field(&arg, "body"),
                };
                match self.net.fetch(&req) {
                    Ok(resp) => json!({ "ok": true, "status": resp.status, "body": resp.body }).to_string(),
                    Err(e) => err_reply(&e),
                }
            }
            other => err_reply(&format!("unsupported net api: {other}")),
        }
    }

    fn service_time(&mut self, call: &HostCall) -> String {
        if !self.toggles.clock {
            return err_reply("clock interface disabled");
        }
        match call.api_name.as_str() {
            "time.now" | "time.monotonic" => json!({ "ok": true, "ms": self.clock_ms }).to_string(),
            other => err_reply(&format!("unknown time api: {other}")),
        }
    }

    fn service_random(&mut self, call: &HostCall) -> String {
        if !self.toggles.randomness {
            return err_reply("randomness interface disabled");
        }
        // SplitMix64 — small, fast, self-contained. A real host can reseed.
        self.rng_state = self.rng_state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.rng_state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        match call.api_name.as_str() {
            "random.next" => {
                let unit = (z >> 11) as f64 / (1u64 << 53) as f64;
                json!({ "ok": true, "value": unit }).to_string()
            }
            "random.bytes" => {
                let n = first_arg(&call.payload)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(16)
                    .min(4096) as usize;
                let mut bytes = Vec::with_capacity(n);
                let mut s = z;
                for _ in 0..n {
                    s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    bytes.push((s >> 56) as u8);
                }
                json!({ "ok": true, "bytes": bytes }).to_string()
            }
            other => err_reply(&format!("unknown random api: {other}")),
        }
    }

    /// `text.atlas` — rasterise the bundled UI font (regular + bold) into a single
    /// coverage atlas and return it with per-glyph metrics, so the SDK can render
    /// real anti-aliased text by sampling a texture instead of stroking capsules.
    /// Arg: `{ size: <px> }` (the raster cap size; the atlas is scaled on the GPU).
    /// Reply: `{ ok, width, height, pxSize, ascent, descent, lineHeight,
    ///           data (base64 R8 coverage), regular:{ch:{...}}, bold:{ch:{...}} }`
    /// where each glyph is `{ x, y, w, h, bx (left bearing), by (bottom vs
    /// baseline, y-up), adv (advance) }` in atlas pixels.
    fn service_text(&mut self, call: &HostCall) -> String {
        let arg = first_arg(&call.payload).unwrap_or(Value::Null);
        let px = arg
            .get("size")
            .and_then(|v| v.as_f64())
            .unwrap_or(44.0)
            .clamp(8.0, 160.0)
            .round() as u32;
        if let Some(cached) = self.atlas_cache.get(&px) {
            return cached.clone();
        }
        let reply = build_text_atlas(px as f32);
        self.atlas_cache.insert(px, reply.clone());
        reply
    }
}

/// Rasterise regular+bold printable ASCII into one shelf-packed R8 coverage atlas.
fn build_text_atlas(px: f32) -> String {
    use base64::Engine;
    use fontdue::{Font, FontSettings};

    let fonts = [
        Font::from_bytes(FONT_REGULAR, FontSettings::default()),
        Font::from_bytes(FONT_BOLD, FontSettings::default()),
    ];
    let fonts: Vec<Font> = fonts.into_iter().filter_map(|f| f.ok()).collect();
    if fonts.len() != 2 {
        return err_reply("font load failed");
    }
    let weights = ["regular", "bold"];

    struct G {
        weight: usize,
        ch: char,
        w: usize,
        h: usize,
        bx: f32,
        by: f32,
        adv: f32,
        bitmap: Vec<u8>,
    }
    let mut glyphs: Vec<G> = Vec::new();
    for (wi, font) in fonts.iter().enumerate() {
        for code in 32u32..=126 {
            let ch = char::from_u32(code).unwrap();
            let (m, bitmap) = font.rasterize(ch, px);
            glyphs.push(G {
                weight: wi,
                ch,
                w: m.width,
                h: m.height,
                bx: m.xmin as f32,
                by: m.ymin as f32,
                adv: m.advance_width,
                bitmap,
            });
        }
    }

    // Shelf-pack into a fixed-width atlas, growing the height as needed.
    let atlas_w: usize = 512;
    let pad: usize = 1;
    let mut pen_x = pad;
    let mut pen_y = pad;
    let mut row_h = 0usize;
    let mut placed: Vec<(usize, usize)> = Vec::with_capacity(glyphs.len()); // (x,y) per glyph
    for g in &glyphs {
        if pen_x + g.w + pad > atlas_w {
            pen_x = pad;
            pen_y += row_h + pad;
            row_h = 0;
        }
        placed.push((pen_x, pen_y));
        pen_x += g.w + pad;
        if g.h > row_h {
            row_h = g.h;
        }
    }
    let atlas_h = (pen_y + row_h + pad).next_power_of_two();
    let mut data = vec![0u8; atlas_w * atlas_h];
    for (i, g) in glyphs.iter().enumerate() {
        let (gx, gy) = placed[i];
        for row in 0..g.h {
            let dst = (gy + row) * atlas_w + gx;
            let src = row * g.w;
            data[dst..dst + g.w].copy_from_slice(&g.bitmap[src..src + g.w]);
        }
    }

    // Per-weight glyph metric maps.
    let mut maps: [serde_json::Map<String, Value>; 2] = [Default::default(), Default::default()];
    for (i, g) in glyphs.iter().enumerate() {
        let (gx, gy) = placed[i];
        maps[g.weight].insert(
            g.ch.to_string(),
            json!({ "x": gx, "y": gy, "w": g.w, "h": g.h, "bx": g.bx, "by": g.by, "adv": g.adv }),
        );
    }
    let lm = fonts[0].horizontal_line_metrics(px).unwrap_or(fontdue::LineMetrics {
        ascent: px * 0.9,
        descent: -px * 0.2,
        line_gap: 0.0,
        new_line_size: px * 1.2,
    });
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let mut obj = serde_json::Map::new();
    obj.insert("ok".into(), Value::Bool(true));
    obj.insert("width".into(), json!(atlas_w));
    obj.insert("height".into(), json!(atlas_h));
    obj.insert("pxSize".into(), json!(px));
    obj.insert("ascent".into(), json!(lm.ascent));
    obj.insert("descent".into(), json!(lm.descent));
    obj.insert("lineHeight".into(), json!(lm.new_line_size));
    obj.insert("data".into(), Value::String(b64));
    obj.insert(weights[0].into(), Value::Object(maps[0].clone()));
    obj.insert(weights[1].into(), Value::Object(maps[1].clone()));
    Value::Object(obj).to_string()
}

// ---- payload helpers --------------------------------------------------------

fn first_arg(payload: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(payload).ok()?;
    match v {
        Value::Array(mut items) if !items.is_empty() => Some(items.remove(0)),
        Value::Array(_) => None,
        other => Some(other),
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// A required string field, defaulting to empty.
fn obj_str(v: &Value, key: &str) -> String {
    str_field(v, key).unwrap_or_default()
}

/// The argument as a bare string (for APIs taking just a path/id).
fn str_or(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => str_field(other, "path").unwrap_or_default(),
    }
}

fn err_reply(msg: &str) -> String {
    json!({ "ok": false, "error": msg }).to_string()
}

fn result_reply(r: Result<(), String>) -> String {
    match r {
        Ok(()) => json!({ "ok": true }).to_string(),
        Err(e) => err_reply(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hc(api: &str, payload: &str) -> HostCall {
        HostCall { machine_id: "m".into(), api_name: api.into(), payload: payload.into() }
    }

    #[test]
    fn memory_fs_roundtrip_and_listing() {
        let mut fs = MemoryFileStore::new();
        fs.write("/a/b.txt", b"hello").unwrap();
        fs.write("/a/c.txt", b"hi").unwrap();
        assert_eq!(fs.read("/a/b.txt").unwrap(), b"hello");
        assert!(fs.exists("/a/b.txt"));
        let mut entries = fs.list("/a").unwrap();
        entries.sort();
        assert_eq!(entries, vec!["b.txt", "c.txt"]);
        assert_eq!(fs.stat("/a/b.txt").unwrap().size, 5);
        fs.delete("/a/b.txt").unwrap();
        assert!(!fs.exists("/a/b.txt"));
        assert_eq!(fs.used_bytes(), 2);
    }

    #[test]
    fn memory_fs_rejects_escape_and_enforces_cap() {
        let mut fs = MemoryFileStore::with_capacity(8);
        assert!(fs.write("/../escape", b"x").is_err());
        fs.write("/ok", b"12345678").unwrap();
        assert!(fs.write("/more", b"9").is_err(), "cap enforced");
    }

    #[test]
    fn native_fs_maps_to_real_dir_and_sandboxes() {
        let dir = std::env::temp_dir().join(format!("elpa-fs-test-{}", std::process::id()));
        let mut fs = NativeFileStore::new(&dir).unwrap();
        fs.write("/docs/note.txt", b"native").unwrap();
        assert_eq!(fs.read("/docs/note.txt").unwrap(), b"native");
        assert!(dir.join("docs").join("note.txt").exists(), "mapped to real disk");
        assert!(fs.read("/../../etc/passwd").is_err(), "escape blocked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn service_routes_only_env_families() {
        let mut env = HostEnv::default();
        assert!(env.service(&hc("gpu.submit", "[]")).is_none(), "GPU is not ours");
        assert!(env.service(&hc("fs.exists", r#"["/x"]"#)).is_some());
    }

    #[test]
    fn fs_service_write_read_through_host_calls() {
        let mut env = HostEnv::default();
        let w = env.service(&hc("fs.write", r#"[{"path":"/f.txt","data":"abc"}]"#)).unwrap();
        assert!(w.contains("\"ok\":true"));
        let r = env.service(&hc("fs.read", r#"[{"path":"/f.txt"}]"#)).unwrap();
        assert!(r.contains("abc"), "got {r}");
    }

    #[test]
    fn disabled_family_reports_disabled() {
        let mut env = HostEnv::default();
        env.set_family("fs", false);
        let r = env.service(&hc("fs.read", r#"["/f"]"#)).unwrap();
        assert!(r.contains("disabled"), "got {r}");
    }

    #[test]
    fn network_denied_by_default_then_granted() {
        let mut env = HostEnv::default();
        env.set_family("net", true); // toggle on, but no provider yet
        let r = env.service(&hc("net.fetch", r#"[{"url":"https://x"}]"#)).unwrap();
        assert!(r.contains("not provisioned"), "got {r}");

        env.set_net(Box::new(ClosureNet(|req: &NetRequest| {
            Ok(NetResponse { status: 200, body: format!("fetched {}", req.url) })
        })));
        let r = env.service(&hc("net.fetch", r#"[{"url":"https://x"}]"#)).unwrap();
        assert!(r.contains("\"status\":200") && r.contains("fetched https://x"), "got {r}");
    }

    #[test]
    fn clock_and_random_are_gated() {
        let mut env = HostEnv::default();
        // clock on by default
        let t = env.service(&hc("time.now", "[]")).unwrap();
        assert!(t.contains("\"ok\":true"));
        // randomness off by default
        let r = env.service(&hc("random.next", "[]")).unwrap();
        assert!(r.contains("disabled"));
        env.set_family("random", true);
        let r = env.service(&hc("random.next", "[]")).unwrap();
        assert!(r.contains("\"value\""));
    }
}
