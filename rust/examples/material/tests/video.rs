//! The gallery's `VideoPlayer` as *streaming* video: an animated GIF decoded to
//! RGBA frames that the frame clock advances while playing. Where `media.rs`
//! proves a still image flows end to end, this proves a multi-frame source keeps
//! advancing — distinct frames are uploaded over time once playback is toggled on
//! (the `p` key), and stays put when paused.

use elpa::protocol::EncoderCommand;
use elpa::{Elpa, EnvToggles, HeadlessBackend, InputEvent, SurfaceInfo};
use std::io::Cursor;

/// A 3-frame 4x4 animated GIF, each frame a distinct solid colour (so an upload's
/// bytes identify which frame is on screen).
fn fixture_gif() -> Vec<u8> {
    use image::codecs::gif::GifEncoder;
    use image::{Delay, Frame, RgbaImage};
    let mut buf = Cursor::new(Vec::new());
    {
        let mut enc = GifEncoder::new(&mut buf);
        for c in [[255u8, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]] {
            let img = RgbaImage::from_pixel(4, 4, image::Rgba(c));
            enc.encode_frame(Frame::from_parts(img, 0, 0, Delay::from_numer_denom_ms(100, 1)))
                .expect("encode gif frame");
        }
    }
    buf.into_inner()
}

fn gallery_playing_video(gif: Vec<u8>) -> Elpa<HeadlessBackend> {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_material::gallery_program(),
    )
    .expect("gallery compiles");
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.env_mut().set_media_fetcher(Box::new(move |_url: &str| Ok(gif.clone())));
    app.start();
    let _ = app.take_log();
    // Go to MEDIA (tab 3); the VideoPlayer requests the network GIF.
    for _ in 0..3 {
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
    }
    app
}

/// The base64 RGBA blobs uploaded to the video texture in the last frame.
fn frame_uploads(app: &Elpa<HeadlessBackend>) -> Vec<String> {
    let Some(frame) = app.last_frame() else { return vec![] };
    frame
        .commands
        .iter()
        .filter_map(|c| match c {
            EncoderCommand::WriteTexture { texture, data_b64, .. }
                if texture.starts_with("elpa.m3.img.tex.") =>
            {
                Some(data_b64.clone())
            }
            _ => None,
        })
        .collect()
}

/// Drive `frames` ticks, returning the set of distinct video-frame uploads seen.
fn distinct_uploads_over(app: &mut Elpa<HeadlessBackend>, frames: usize) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..frames {
        app.animate(16.0);
        for u in frame_uploads(app) {
            if !seen.contains(&u) {
                seen.push(u);
            }
        }
        // The decode runs on a worker thread; give it a moment to publish.
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    seen
}

#[test]
fn video_streams_distinct_frames_while_playing() {
    let mut app = gallery_playing_video(fixture_gif());
    app.send_event(&InputEvent::KeyDown { key: "p".into() }); // toggle playing on
    let seen = distinct_uploads_over(&mut app, 240);
    assert!(app.trap_reason().is_none(), "no trap streaming video: {:?}", app.trap_reason());
    assert!(
        seen.len() >= 2,
        "a playing video advances through distinct frames (saw {})",
        seen.len()
    );
}

#[test]
fn paused_video_holds_a_single_frame() {
    // Never toggled to playing: the clip stays on its first frame, so at most one
    // distinct upload is ever produced (no runaway re-upload while idle).
    let mut app = gallery_playing_video(fixture_gif());
    let seen = distinct_uploads_over(&mut app, 120);
    assert!(app.trap_reason().is_none(), "no trap with a paused video");
    assert!(seen.len() <= 1, "a paused video does not advance frames (saw {})", seen.len());
}
