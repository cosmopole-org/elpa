//! Asynchronous media loading: fetch (network) + decode (PNG/JPEG stills and
//! animated GIF "video") into RGBA8 frames, delivered to the guest as textures.
//!
//! The guest never blocks on a load. It `media.open`s a source (a URL or a
//! storage path) and then, each frame, `media.poll`s for completion and pulls
//! decoded frames with `media.frame`. On native the fetch+decode runs on a
//! dedicated worker thread, so a multi-megabyte download and decode never stall
//! the render loop; on wasm (no threads) it decodes inline at `open` time using
//! the host's fetcher. Either way the host-call seam stays synchronous and the
//! guest drives everything from its frame tick.

use base64::Engine as _;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

/// A host-supplied, thread-safe binary fetcher (e.g. a blocking HTTP GET). The
/// engine owns it on the worker thread, so it must be `Send`.
pub type MediaFetcher = Box<dyn FnMut(&str) -> Result<Vec<u8>, String> + Send>;

/// One decoded RGBA8 frame and how long it should show (0 for a still image).
#[derive(Clone)]
pub struct MediaFrame {
    pub data: Vec<u8>,
    pub delay_ms: u32,
}

/// The decode state of a media id.
pub enum MediaState {
    Pending,
    Ready { width: u32, height: u32, frames: Vec<MediaFrame>, total_ms: u32 },
    Failed(String),
}

/// Where a source's bytes come from. Network URLs are fetched on the worker
/// (slow, off-thread); storage paths are read by the host up front (fast) and
/// handed in as bytes so only the *decode* runs off-thread.
pub enum MediaSource {
    Url(String),
    Bytes(Vec<u8>),
}

type Results = Arc<Mutex<HashMap<String, MediaState>>>;

/// Decode raw bytes into RGBA8 frames. Animated GIFs become multi-frame
/// sequences (real streaming video); everything else is a single still.
fn decode(bytes: &[u8]) -> MediaState {
    if bytes.len() >= 3 && &bytes[0..3] == b"GIF" {
        match decode_gif(bytes) {
            Ok(s) => return s,
            Err(e) => return MediaState::Failed(e),
        }
    }
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            MediaState::Ready { width: w, height: h, frames: vec![MediaFrame { data: rgba.into_raw(), delay_ms: 0 }], total_ms: 0 }
        }
        Err(e) => MediaState::Failed(e.to_string()),
    }
}

fn decode_gif(bytes: &[u8]) -> Result<MediaState, String> {
    use image::codecs::gif::GifDecoder;
    use image::AnimationDecoder;
    let dec = GifDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let frames = dec.into_frames().collect_frames().map_err(|e| e.to_string())?;
    if frames.is_empty() {
        return Err("gif had no frames".to_string());
    }
    let mut out = Vec::with_capacity(frames.len());
    let mut total = 0u32;
    let (mut w, mut h) = (0u32, 0u32);
    for f in frames {
        let (n, d) = f.delay().numer_denom_ms();
        let ms = if d == 0 { 0 } else { n / d };
        // A 0ms delay (some encoders) would freeze playback; clamp to a sane tick.
        let ms = if ms == 0 { 60 } else { ms };
        let buf = f.into_buffer();
        let (fw, fh) = buf.dimensions();
        w = fw;
        h = fh;
        total += ms;
        out.push(MediaFrame { data: buf.into_raw(), delay_ms: ms });
    }
    Ok(MediaState::Ready { width: w, height: h, frames: out, total_ms: total })
}

fn process(source: MediaSource, fetcher: &mut Option<MediaFetcher>) -> MediaState {
    let bytes = match source {
        MediaSource::Bytes(b) => Ok(b),
        MediaSource::Url(u) => match fetcher {
            Some(f) => f(&u),
            None => Err("no network fetcher provisioned for media".to_string()),
        },
    };
    match bytes {
        Ok(b) => decode(&b),
        Err(e) => MediaState::Failed(e),
    }
}

// ---------------------------------------------------------------- native ------
#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;
    use std::sync::mpsc::{channel, Sender};

    struct Job {
        id: String,
        source: MediaSource,
    }

    /// The off-main-thread engine: a worker thread owns the fetcher and decodes
    /// jobs as they arrive, publishing results into the shared map the host reads.
    pub struct MediaEngine {
        tx: Sender<Job>,
        results: Results,
        seen: HashMap<String, ()>,
    }

    impl MediaEngine {
        pub fn start(fetcher: Option<MediaFetcher>) -> Self {
            let (tx, rx) = channel::<Job>();
            let results: Results = Arc::new(Mutex::new(HashMap::new()));
            let worker_results = results.clone();
            std::thread::Builder::new()
                .name("elpa-media".to_string())
                .spawn(move || {
                    let mut fetcher = fetcher;
                    while let Ok(job) = rx.recv() {
                        let state = process(job.source, &mut fetcher);
                        if let Ok(mut map) = worker_results.lock() {
                            map.insert(job.id, state);
                        }
                    }
                })
                .expect("spawn media worker");
            MediaEngine { tx, results, seen: HashMap::new() }
        }

        pub fn open(&mut self, id: &str, source: MediaSource) {
            if self.seen.contains_key(id) {
                return;
            }
            self.seen.insert(id.to_string(), ());
            if let Ok(mut map) = self.results.lock() {
                map.insert(id.to_string(), MediaState::Pending);
            }
            // If the worker thread is gone the load simply never completes; the
            // guest keeps showing its placeholder rather than trapping.
            let _ = self.tx.send(Job { id: id.to_string(), source });
        }

        pub fn with_results<R>(&self, f: impl FnOnce(&HashMap<String, MediaState>) -> R) -> R {
            let map = self.results.lock().expect("media results lock");
            f(&map)
        }
    }
}

// ------------------------------------------------------------------ wasm ------
#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;

    /// Without threads, decode inline at `open` time (the host's fetcher does the
    /// blocking work). Still asynchronous from the guest's view: it polls and
    /// shows a placeholder until the result is present.
    pub struct MediaEngine {
        fetcher: Option<MediaFetcher>,
        results: HashMap<String, MediaState>,
    }

    impl MediaEngine {
        pub fn start(fetcher: Option<MediaFetcher>) -> Self {
            MediaEngine { fetcher, results: HashMap::new() }
        }

        pub fn open(&mut self, id: &str, source: MediaSource) {
            if self.results.contains_key(id) {
                return;
            }
            let state = process(source, &mut self.fetcher);
            self.results.insert(id.to_string(), state);
        }

        pub fn with_results<R>(&self, f: impl FnOnce(&HashMap<String, MediaState>) -> R) -> R {
            f(&self.results)
        }
    }
}

pub use imp::MediaEngine;

impl MediaEngine {
    /// Poll a media id's load status as a small metadata reply (no pixel copy).
    pub fn poll_json(&self, id: &str) -> serde_json::Value {
        self.with_results(|map| match map.get(id) {
            None => serde_json::json!({ "ok": true, "ready": false, "pending": false }),
            Some(MediaState::Pending) => serde_json::json!({ "ok": true, "ready": false, "pending": true }),
            Some(MediaState::Failed(e)) => serde_json::json!({ "ok": true, "ready": false, "failed": true, "error": e }),
            Some(MediaState::Ready { width, height, frames, total_ms }) => serde_json::json!({
                "ok": true, "ready": true, "width": width, "height": height,
                "frames": frames.len(), "durationMs": total_ms,
            }),
        })
    }

    /// Fetch one decoded frame's RGBA8 pixels (base64) for upload as a texture.
    pub fn frame_json(&self, id: &str, index: usize) -> serde_json::Value {
        self.with_results(|map| match map.get(id) {
            Some(MediaState::Ready { width, height, frames, .. }) if !frames.is_empty() => {
                let f = &frames[index % frames.len()];
                let data = base64::engine::general_purpose::STANDARD.encode(&f.data);
                serde_json::json!({ "ok": true, "ready": true, "width": width, "height": height,
                    "index": index % frames.len(), "delayMs": f.delay_ms, "data": data })
            }
            _ => serde_json::json!({ "ok": true, "ready": false }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1x1 red PNG.
    fn red_png() -> Vec<u8> {
        // Built with the `image` crate so the test stays self-contained.
        let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn decodes_a_still_png_to_one_rgba_frame() {
        match decode(&red_png()) {
            MediaState::Ready { width, height, frames, .. } => {
                assert_eq!((width, height), (1, 1));
                assert_eq!(frames.len(), 1);
                assert_eq!(frames[0].data, vec![255, 0, 0, 255]);
            }
            _ => panic!("expected a ready still"),
        }
    }

    #[test]
    fn engine_loads_a_url_and_reports_ready_then_serves_the_frame() {
        let png = red_png();
        let mut eng = MediaEngine::start(Some(Box::new(move |_url: &str| Ok(png.clone()))));
        eng.open("img:test", MediaSource::Url("https://example/x.png".to_string()));
        // Native decodes on a worker; spin briefly until the result lands.
        let mut ready = false;
        for _ in 0..200 {
            let p = eng.poll_json("img:test");
            if p["ready"].as_bool().unwrap_or(false) {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(ready, "media engine should resolve the URL load");
        let f = eng.frame_json("img:test", 0);
        assert_eq!(f["width"].as_u64(), Some(1));
        assert!(f["data"].as_str().is_some(), "frame carries base64 pixels");
    }

    #[test]
    fn a_missing_fetcher_fails_a_url_gracefully() {
        let mut eng = MediaEngine::start(None);
        eng.open("img:nofetch", MediaSource::Url("https://x/y.png".to_string()));
        let mut settled = false;
        for _ in 0..200 {
            let p = eng.poll_json("img:nofetch");
            if p["failed"].as_bool().unwrap_or(false) {
                settled = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(settled, "a URL load with no fetcher should fail, not hang the guest");
    }
}
