//! The async media pipeline end to end on a real (headless) Elpa instance: a
//! network image is "downloaded" through a wired fetcher, decoded off the render
//! thread into RGBA, uploaded as a GPU texture, and drawn by the kit's dedicated
//! image pipeline — all without blocking the frame loop. Proves the whole seam
//! (`media.open`/`poll`/`frame` → `writeTexture` → image draw) headlessly; the
//! actual pixels still need an on-device run to eyeball.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
use elpa::{Elpa, EnvToggles, HeadlessBackend, InputEvent, SurfaceInfo};
use std::io::Cursor;

/// A distinctive 6x4 RGBA PNG built in-test (so we can assert the decoded texture
/// took on its exact dimensions, i.e. real pixels flowed end to end).
fn fixture_png() -> Vec<u8> {
    let img = image::RgbaImage::from_fn(6, 4, |x, _| image::Rgba([(x * 40) as u8, 10, 200, 255]));
    let mut buf = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img).write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

fn gallery() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(900, 1400, 1.0), &elpa_material::gallery_program())
        .expect("gallery compiles")
}

/// Grant network + filesystem and install a media fetcher that serves `bytes` for
/// any URL (the off-thread decode is real; only the download is stubbed).
fn wire_media(app: &mut Elpa<HeadlessBackend>, bytes: Vec<u8>) {
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.env_mut().set_media_fetcher(Box::new(move |_url: &str| Ok(bytes.clone())));
}

fn img_texture(app: &Elpa<HeadlessBackend>) -> Option<(u32, u32)> {
    let frame = app.last_frame()?;
    frame.resources.iter().find_map(|r| match r {
        ResourceDesc::Texture(t) if t.id.starts_with("elpa.m3.img.tex.") && (t.size.width > 1 || t.size.height > 1) => {
            Some((t.size.width, t.size.height))
        }
        _ => None,
    })
}

#[test]
fn network_image_decodes_off_thread_and_uploads_a_texture() {
    let mut app = gallery();
    wire_media(&mut app, fixture_png());
    app.start();
    let _ = app.take_log();

    // Go to the MEDIA section (tab 3) — its Image widget requests the network load.
    for _ in 0..3 {
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
    }
    assert!(app.trap_reason().is_none(), "no trap entering media: {:?}", app.trap_reason());

    // The decode runs on a worker thread; the kit polls it on the frame clock.
    // Drive frames until the real (non-placeholder) texture appears.
    let mut size = None;
    for _ in 0..400 {
        app.animate(16.0);
        if let Some(s) = img_texture(&app) {
            size = Some(s);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
    assert_eq!(size, Some((6, 4)), "the decoded image texture took the PNG's exact size");
    assert!(app.trap_reason().is_none(), "no trap loading media");
    assert!(app.take_log().is_empty(), "no host errors loading media");

    let frame = app.last_frame().unwrap();
    // The image pipeline is present and the texture was uploaded with real pixels.
    assert!(
        frame.resources.iter().any(|r| r.id() == "elpa.m3.img.pipe"),
        "the dedicated image pipeline is in the frame"
    );
    let uploaded = frame.commands.iter().any(|c| matches!(
        c, EncoderCommand::WriteTexture { texture, size, .. }
            if texture.starts_with("elpa.m3.img.tex.") && size.width == 6 && size.height == 4));
    assert!(uploaded, "the decoded RGBA frame was uploaded via writeTexture");

    // The frame draws through the image pipeline (a real textured quad), in
    // addition to the SDF pipeline — i.e. more than one draw.
    let draws = frame
        .commands
        .iter()
        .filter_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .flat_map(|rp| rp.commands.iter())
        .filter(|c| matches!(c, RenderCommand::Draw { .. }))
        .count();
    assert!(draws >= 2, "image draw(s) interleave with the SDF draw(s)");
}

#[test]
fn missing_media_fetcher_keeps_the_ui_alive_with_a_placeholder() {
    // Network on but no fetcher wired: the load fails gracefully and the UI keeps
    // rendering (placeholder texture), never trapping.
    let mut app = gallery();
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.start();
    for _ in 0..3 {
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
    }
    for _ in 0..10 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "no trap without a fetcher");
    assert!(app.last_stats().presented, "media section still presents");
}
