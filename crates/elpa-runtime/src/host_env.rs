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

use crate::media::{MediaEngine, MediaFetcher, MediaSource};
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
#[derive(Clone, Debug, Default)]
pub struct NetResponse {
    pub status: u16,
    pub body: String,
    /// Raw response bytes, when the provider fetched binary (e.g. a font file).
    /// Text replies leave this `None` and use `body`; `text.atlas` reads it to
    /// load a font by URL without lossy UTF-8 round-tripping.
    pub bytes: Option<Vec<u8>>,
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
    /// Rasterised font atlases keyed by `"<px>|<source>"`, so `text.atlas` builds
    /// each (size, font) once and replays the cached reply on subsequent calls.
    atlas_cache: BTreeMap<String, String>,
    /// The default UI font (regular, bold) bytes, downloaded **once** through the
    /// host's `NetProvider` the first time `text.atlas` needs it and cached here
    /// for the process lifetime. No font is bundled into the binary: it is fetched
    /// at runtime (see [`DEFAULT_FONT_URL`]), so a build that never wires a network
    /// provider simply has no default atlas and callers fall back to their own
    /// vector text — the call still never traps.
    default_font: Option<(Vec<u8>, Vec<u8>)>,
    /// The async media engine (image/animated-GIF decode → RGBA frames), started
    /// lazily on the first `media.*` call. `media_fetcher` holds the host-supplied
    /// binary fetcher until then; on native the engine moves it onto a worker
    /// thread so loads run off the render loop.
    media: Option<MediaEngine>,
    media_fetcher: Option<MediaFetcher>,
}

/// The default UI font — **Roboto** (Apache-2.0), Material Design's canonical
/// sans-serif. It is *not* bundled into the binary; the runtime downloads it once
/// through the host's [`NetProvider`] the first time it rasterises text (i.e. as
/// the runtime loads its first frame), then caches the bytes. The URLs are pinned,
/// immutable CDN artifacts (a versioned npm package mirrored by jsDelivr) and are
/// served with permissive CORS so the browser build's synchronous fetch works.
const DEFAULT_FONT_URL: &str =
    "https://cdn.jsdelivr.net/npm/@expo-google-fonts/roboto@0.2.3/Roboto_400Regular.ttf";
const DEFAULT_FONT_BOLD_URL: &str =
    "https://cdn.jsdelivr.net/npm/@expo-google-fonts/roboto@0.2.3/Roboto_700Bold.ttf";

impl Default for HostEnv {
    fn default() -> Self {
        HostEnv::new(Box::new(MemoryFileStore::new()), Box::new(DeniedNet))
    }
}

impl HostEnv {
    pub fn new(fs: Box<dyn FileStore>, net: Box<dyn NetProvider>) -> Self {
        HostEnv { toggles: EnvToggles::default(), fs, net, clock_ms: 0, rng_state: 0x9E3779B97F4A7C15, atlas_cache: BTreeMap::new(), default_font: None, media: None, media_fetcher: None }
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
    /// Install the binary fetcher the async media engine uses to download media
    /// by URL. It must be `Send` because, on native, the engine runs it on a
    /// worker thread so fetch+decode never block the render loop. Storage-path
    /// media doesn't need it (the host reads those bytes itself). Set this before
    /// the first `media.*` call; it is consumed when the engine starts.
    pub fn set_media_fetcher(&mut self, fetcher: MediaFetcher) {
        self.media_fetcher = Some(fetcher);
        self.media = None; // restart the engine with the new fetcher on next use
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
            "media" => Some(self.service_media(call)),
            _ => None,
        }
    }

    /// `media.*` — asynchronous image / animated-GIF loading.
    ///   media.open  { id, url? , path? }  -> { ok }     (non-blocking; kicks off load)
    ///   media.poll  { id }                -> { ok, ready, width, height, frames, ... }
    ///   media.frame { id, index }         -> { ok, ready, width, height, data(b64 RGBA8) }
    fn service_media(&mut self, call: &HostCall) -> String {
        let arg = first_arg(&call.payload).unwrap_or(Value::Null);
        match call.api_name.as_str() {
            "media.open" => {
                let id = obj_str(&arg, "id");
                if id.is_empty() {
                    return err_reply("media.open requires an id");
                }
                // Resolve the source: a storage path is read here (fast, local);
                // a URL is handed to the engine to fetch off-thread.
                let source = if let Some(path) = str_field(&arg, "path") {
                    if !self.toggles.filesystem {
                        return err_reply("filesystem interface disabled");
                    }
                    match self.fs.read(&path) {
                        Ok(bytes) => MediaSource::Bytes(bytes),
                        Err(e) => return err_reply(&e),
                    }
                } else if let Some(url) = str_field(&arg, "url") {
                    if !self.toggles.network {
                        return err_reply("network interface disabled");
                    }
                    MediaSource::Url(url)
                } else {
                    return err_reply("media.open requires a url or path");
                };
                self.media_engine().open(&id, source);
                json!({ "ok": true }).to_string()
            }
            "media.poll" => {
                let id = obj_str(&arg, "id");
                self.media_engine().poll_json(&id).to_string()
            }
            "media.frame" => {
                let id = obj_str(&arg, "id");
                let index = arg.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                self.media_engine().frame_json(&id, index).to_string()
            }
            other => err_reply(&format!("unknown media api: {other}")),
        }
    }

    /// The media engine, started on first use (moving the fetcher onto its worker).
    fn media_engine(&mut self) -> &mut MediaEngine {
        if self.media.is_none() {
            self.media = Some(MediaEngine::start(self.media_fetcher.take()));
        }
        self.media.as_mut().expect("media engine started")
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

    /// `text.atlas` — rasterise a UI font (regular + bold) into a single coverage
    /// atlas and return it with per-glyph metrics, so the SDK can render real
    /// anti-aliased text by sampling a texture instead of stroking capsules.
    ///
    /// Arg: `{ size: <px>, url?, boldUrl?, path?, boldPath? }`. With no source the
    /// default font is used (downloaded once at runtime — see [`DEFAULT_FONT_URL`]);
    /// `path`/`boldPath` load font bytes from the fabricated filesystem;
    /// `url`/`boldUrl` fetch them through the host's `NetProvider` (binary-safe via
    /// `NetResponse.bytes`). A failed/denied custom source falls back to the default
    /// font; if even the default cannot be obtained (no network provisioned) the
    /// call returns an error reply rather than trapping, so the caller can fall back
    /// to its own vector text.
    ///
    /// Reply: `{ ok, source, width, height, pxSize, ascent, descent, lineHeight,
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
        // The cache key folds in the font source so switching fonts rebuilds.
        let url = str_field(&arg, "url");
        let bold_url = str_field(&arg, "boldUrl");
        let path = str_field(&arg, "path");
        let bold_path = str_field(&arg, "boldPath");
        let src_key = format!(
            "{}|{}|{}|{}",
            url.as_deref().unwrap_or(""),
            bold_url.as_deref().unwrap_or(""),
            path.as_deref().unwrap_or(""),
            bold_path.as_deref().unwrap_or("")
        );
        let cache_key = format!("{px}|{src_key}");
        if let Some(cached) = self.atlas_cache.get(&cache_key) {
            return cached.clone();
        }
        let Some((reg, bold, source)) = self.resolve_font_bytes(&url, &bold_url, &path, &bold_path)
        else {
            // No usable font at all (no source resolved and the default could not be
            // downloaded). Don't cache the failure, so a later call — once a network
            // provider is wired — can still succeed.
            return err_reply("no font available (default font download failed — wire a network provider)");
        };
        // A custom source whose bytes fail to parse falls back to the default font.
        let fallback = self.default_font_bytes();
        let reply = build_text_atlas(
            px as f32,
            &reg,
            &bold,
            &source,
            fallback.as_ref().map(|(r, b)| (r.as_slice(), b.as_slice())),
        );
        // Only memoise successful builds; an error stays retryable.
        if reply_is_ok(&reply) {
            self.atlas_cache.insert(cache_key, reply.clone());
        }
        reply
    }

    /// Resolve the (regular, bold) font bytes for `text.atlas`, honouring a
    /// storage `path` or a `url` (each with an optional bold companion) and
    /// falling back to the default font when a source is absent, disabled, or
    /// fails. Returns the bytes plus a label describing what was used, or `None`
    /// when no source resolves *and* the default font cannot be downloaded.
    fn resolve_font_bytes(
        &mut self,
        url: &Option<String>,
        bold_url: &Option<String>,
        path: &Option<String>,
        bold_path: &Option<String>,
    ) -> Option<(Vec<u8>, Vec<u8>, String)> {
        if let Some(p) = path {
            if self.toggles.filesystem {
                if let Ok(reg) = self.fs.read(p) {
                    if !reg.is_empty() {
                        let bold = bold_path
                            .as_ref()
                            .and_then(|bp| self.fs.read(bp).ok())
                            .filter(|b| !b.is_empty())
                            .unwrap_or_else(|| reg.clone());
                        return Some((reg, bold, format!("path:{p}")));
                    }
                }
            }
        }
        if let Some(u) = url {
            if self.toggles.network {
                if let Some(reg) = self.fetch_font(u) {
                    let bold = bold_url
                        .as_ref()
                        .and_then(|bu| self.fetch_font(bu))
                        .unwrap_or_else(|| reg.clone());
                    return Some((reg, bold, format!("url:{u}")));
                }
            }
        }
        self.default_font_bytes().map(|(reg, bold)| (reg, bold, "default".to_string()))
    }

    /// The default font (regular, bold) bytes, downloaded once through the host's
    /// `NetProvider` and cached for the process lifetime. Returns `None` when no
    /// network is provisioned (or the download fails) — there is no bundled font to
    /// fall back to, by design.
    fn default_font_bytes(&mut self) -> Option<(Vec<u8>, Vec<u8>)> {
        if let Some(font) = &self.default_font {
            return Some(font.clone());
        }
        if !self.toggles.network {
            return None;
        }
        let reg = self.fetch_font(DEFAULT_FONT_URL)?;
        // A missing bold face is non-fatal: reuse the regular so text still renders.
        let bold = self.fetch_font(DEFAULT_FONT_BOLD_URL).unwrap_or_else(|| reg.clone());
        self.default_font = Some((reg.clone(), bold.clone()));
        Some((reg, bold))
    }

    /// Fetch font bytes from a URL through the installed `NetProvider`; binary
    /// comes back in `NetResponse.bytes` (preferred) or the raw `body`.
    fn fetch_font(&mut self, url: &str) -> Option<Vec<u8>> {
        let req = NetRequest { method: "GET".to_string(), url: url.to_string(), body: None };
        let resp = self.net.fetch(&req).ok()?;
        let bytes = resp.bytes.unwrap_or_else(|| resp.body.into_bytes());
        if bytes.is_empty() {
            None
        } else {
            Some(bytes)
        }
    }
}

/// Rasterise regular+bold printable ASCII into one shelf-packed R8 coverage
/// atlas. If the supplied bytes fail to parse, falls back to `fallback` (the
/// downloaded default font) when one is available, else returns an error reply.
fn build_text_atlas(
    px: f32,
    reg_bytes: &[u8],
    bold_bytes: &[u8],
    source: &str,
    fallback: Option<(&[u8], &[u8])>,
) -> String {
    use base64::Engine;
    use fontdue::{Font, FontSettings};

    let load = |bytes: &[u8]| Font::from_bytes(bytes, FontSettings::default()).ok();
    let (regular, bold, source) = match (load(reg_bytes), load(bold_bytes)) {
        (Some(r), Some(b)) => (r, b, source.to_string()),
        _ => {
            // Bad custom font → fall back to the default font rather than fail.
            match fallback.and_then(|(r, b)| Some((load(r)?, load(b)?))) {
                Some((r, b)) => (r, b, "default".to_string()),
                None => return err_reply("font load failed"),
            }
        }
    };
    let fonts: Vec<Font> = vec![regular, bold];
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
    obj.insert("source".into(), Value::String(source));
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

/// Whether a JSON reply string carries `"ok": true` (used to avoid memoising
/// failed `text.atlas` builds so they stay retryable once a provider is wired).
fn reply_is_ok(reply: &str) -> bool {
    serde_json::from_str::<Value>(reply)
        .ok()
        .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
        .unwrap_or(false)
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
            Ok(NetResponse { status: 200, body: format!("fetched {}", req.url), bytes: None })
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
