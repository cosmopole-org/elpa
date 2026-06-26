//! The live **Vello** scene backend (the `vello-backend` feature).
//!
//! This is the literal [`SceneOp`] → `vello::Scene` mapping, the scene analog of
//! [`wgpu_backend`](crate::wgpu_backend). It owns a `vello::Renderer`, the per-
//! frame `vello::Scene`, and a wgpu surface (via Vello's re-exported `wgpu`), and
//! rasterizes the encoded scene to that surface.
//!
//! ## Raw wgpu as a subset op
//!
//! A [`SceneOp::RawWgpu`] composites a raw command tree into the *same* surface
//! the vector ops paint. Rather than hard-couple two (possibly different) wgpu
//! versions, the backend invokes a host-supplied [`RawHandler`] with the live
//! device/queue/target view, letting the embedder replay the command tree on the
//! exact device Vello renders with. This keeps the wgpu subset path explicit and
//! version-clean while still drawing into the one shared target.
//!
//! Because Vello is gated behind a non-default feature (it pulls the full GPU +
//! glyph stack), the GPU-free scene orchestration in [`scene_renderer`] is what
//! the default test suite exercises; this file is the production realization.

use base64::Engine as _;

use vello::kurbo::{
    self, Affine as KAffine, BezPath, Cap as KCap, Join as KJoin, Shape as _, Stroke,
};
use vello::peniko::{self, Blob, Brush as PBrush, Color as PColor, Fill as PFill};
use vello::wgpu;
use vello::{AaConfig, Renderer as VRenderer, RendererOptions, Scene as VScene};

use elpa_protocol::{
    Affine, Brush, Cap, Color, Compose, Extend, FillRule, GlyphRun, Gradient, GradientKind, Join,
    Mix, Path, PathEl, Rect, SceneOp, SceneResource, StrokeStyle,
};

use crate::scene_backend::SceneBackend;

/// A host hook that composites a raw wgpu [`Frame`](elpa_protocol::Frame) into
/// the shared target. It receives the live device/queue and the surface texture
/// view Vello is rendering into, so the embedder can run the command tree on the
/// same device (e.g. by driving an [`elpa_renderer::Renderer`](crate::Renderer)
/// whose `WgpuBackend` wraps this device/view).
pub type RawHandler = Box<
    dyn FnMut(&elpa_protocol::Frame, &wgpu::Device, &wgpu::Queue, &wgpu::TextureView, (u32, u32)),
>;

/// A live Vello scene backend bound to a wgpu surface.
pub struct VelloSceneBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: VRenderer,
    scene: VScene,
    /// Decoded scene images, keyed by resource id.
    images: ahash::AHashMap<String, peniko::Image>,
    /// Loaded fonts, keyed by resource id.
    fonts: ahash::AHashMap<String, peniko::Font>,
    /// Optional compositing hook for [`SceneOp::RawWgpu`] ops.
    raw_handler: Option<RawHandler>,
    base_color: PColor,
}

impl VelloSceneBackend {
    /// Build a backend from an already-configured wgpu surface + device/queue.
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
    ) -> Result<Self, vello::Error> {
        let renderer = VRenderer::new(
            &device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: None,
                pipeline_cache: None,
            },
        )?;
        Ok(Self {
            device,
            queue,
            surface,
            config,
            renderer,
            scene: VScene::new(),
            images: ahash::AHashMap::new(),
            fonts: ahash::AHashMap::new(),
            raw_handler: None,
            base_color: PColor::from_rgba8(0, 0, 0, 255),
        })
    }

    /// Build a live backend that **owns** a wgpu surface created from a window /
    /// canvas `target`, acquiring its own adapter + device/queue on Vello's wgpu.
    /// This is the standalone, full-window scene path: a host paints its entire UI
    /// through `scene.submit` and this backend presents it to the window (no
    /// separate wgpu compositor — the [`crate::Renderer`] / [`crate::wgpu_backend`]
    /// path is unused, the [`SceneOp::RawWgpu`] subset op aside).
    ///
    /// The surface is configured `Rgba8Unorm` with `STORAGE_BINDING` because the
    /// scene is rasterized straight onto the surface texture via
    /// [`vello::Renderer::render_to_texture`], which requires exactly that format
    /// and usage.
    pub async fn from_window(
        target: impl Into<wgpu::SurfaceTarget<'static>>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let surface = instance.create_surface(target).map_err(|e| e.to_string())?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| "no compatible GPU adapter for the Vello surface".to_string())?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("elpa-vello-device"),
                    required_features: wgpu::Features::empty(),
                    // Vello's compute pipeline reaches past the conservative
                    // default limits (large storage buffers), so grant whatever
                    // the adapter actually supports.
                    required_limits: adapter.limits(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::STORAGE_BINDING,
            format: wgpu::TextureFormat::Rgba8Unorm,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        Self::new(device, queue, surface, config).map_err(|e| e.to_string())
    }

    /// Install the hook that composites raw wgpu frames into the shared target.
    pub fn set_raw_handler(&mut self, handler: RawHandler) {
        self.raw_handler = Some(handler);
    }

    fn image(&self, id: &str) -> Option<peniko::Image> {
        self.images.get(id).cloned()
    }
}

impl SceneBackend for VelloSceneBackend {
    fn ensure_resource(&mut self, res: &SceneResource) {
        match res {
            SceneResource::Image { id, width, height, data_b64, .. } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) {
                    let blob = Blob::new(std::sync::Arc::new(bytes));
                    let image =
                        peniko::Image::new(blob, peniko::ImageFormat::Rgba8, *width, *height);
                    self.images.insert(id.clone(), image);
                }
            }
            SceneResource::Font { id, data_b64 } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) {
                    let blob = Blob::new(std::sync::Arc::new(bytes));
                    self.fonts.insert(id.clone(), peniko::Font::new(blob, 0));
                }
            }
        }
    }

    fn drop_resource(&mut self, id: &str) {
        self.images.remove(id);
        self.fonts.remove(id);
    }

    fn begin_scene(&mut self) {
        self.scene.reset();
    }

    fn encode_op(&mut self, op: &SceneOp) {
        match op {
            SceneOp::Fill { fill, transform, brush, brush_transform, path } => {
                let shape = to_bez(path);
                self.scene.fill(
                    to_fill(*fill),
                    to_affine(*transform),
                    &to_brush(brush, &self.images),
                    brush_transform.map(to_affine),
                    &shape,
                );
            }
            SceneOp::Stroke { style, transform, brush, brush_transform, path } => {
                let shape = to_bez(path);
                self.scene.stroke(
                    &to_stroke(style),
                    to_affine(*transform),
                    &to_brush(brush, &self.images),
                    brush_transform.map(to_affine),
                    &shape,
                );
            }
            SceneOp::PushLayer { blend, alpha, transform, clip } => {
                let shape = to_bez(clip);
                self.scene.push_layer(
                    peniko::BlendMode::new(to_mix(blend.mix), to_compose(blend.compose)),
                    *alpha,
                    to_affine(*transform),
                    &shape,
                );
            }
            SceneOp::PopLayer => self.scene.pop_layer(),
            SceneOp::DrawImage { image, transform, alpha } => {
                if let Some(mut img) = self.image(image) {
                    img.alpha = *alpha;
                    self.scene.draw_image(&img, to_affine(*transform));
                }
            }
            SceneOp::DrawGlyphs { transform, run } => self.draw_glyph_run(*transform, run),
            SceneOp::RawWgpu { frame } => {
                // The subset op: composite the raw command tree into the same
                // surface via the host hook, on Vello's own device/queue.
                if let Some(handler) = self.raw_handler.as_mut() {
                    if let Ok(tex) = self.surface.get_current_texture() {
                        let view = tex.texture.create_view(&Default::default());
                        handler(
                            frame,
                            &self.device,
                            &self.queue,
                            &view,
                            (self.config.width, self.config.height),
                        );
                        tex.present();
                    }
                }
            }
        }
    }

    fn present_scene(&mut self, _dirty: &[Rect]) {
        let Ok(surface_texture) = self.surface.get_current_texture() else {
            return;
        };
        let params = vello::RenderParams {
            base_color: self.base_color,
            width: self.config.width,
            height: self.config.height,
            antialiasing_method: AaConfig::Area,
        };
        // Render the encoded scene straight onto the surface texture.
        let _ = self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            &self.scene,
            &surface_texture.texture.create_view(&Default::default()),
            &params,
        );
        surface_texture.present();
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    fn surface_format_token(&self) -> String {
        format!("{:?}", self.config.format).to_lowercase()
    }

    fn surface_size(&self) -> Option<(u32, u32)> {
        Some((self.config.width, self.config.height))
    }
}

impl VelloSceneBackend {
    fn draw_glyph_run(&mut self, transform: Affine, run: &GlyphRun) {
        let Some(font) = self.fonts.get(&run.font).cloned() else {
            return;
        };
        let brush = to_brush(&run.brush, &self.images);
        self.scene
            .draw_glyphs(&font)
            .font_size(run.font_size)
            .hint(run.hint)
            .transform(to_affine(transform))
            .brush(&brush)
            .draw(
                PFill::NonZero,
                run.glyphs.iter().map(|g| vello::Glyph {
                    id: g.id,
                    x: g.x,
                    y: g.y,
                }),
            );
    }
}

// ---- protocol → vello/peniko/kurbo mappers ---------------------------------

fn to_affine(a: Affine) -> KAffine {
    KAffine::new(a.0)
}

fn to_fill(f: FillRule) -> PFill {
    match f {
        FillRule::NonZero => PFill::NonZero,
        FillRule::EvenOdd => PFill::EvenOdd,
    }
}

fn to_color(c: Color) -> PColor {
    PColor::new([c.r as f32, c.g as f32, c.b as f32, c.a as f32])
}

fn to_brush(b: &Brush, images: &ahash::AHashMap<String, peniko::Image>) -> PBrush {
    match b {
        Brush::Solid { color } => PBrush::Solid(to_color(*color)),
        Brush::Gradient { gradient } => PBrush::Gradient(to_gradient(gradient)),
        Brush::Image { image, alpha, extend } => match images.get(image) {
            Some(img) => {
                let mut img = img.clone();
                img.alpha = *alpha;
                img.x_extend = to_extend(*extend);
                img.y_extend = to_extend(*extend);
                PBrush::Image(img)
            }
            None => PBrush::Solid(PColor::TRANSPARENT),
        },
    }
}

fn to_gradient(g: &Gradient) -> peniko::Gradient {
    let stops: Vec<peniko::ColorStop> = g
        .stops
        .iter()
        .map(|s| peniko::ColorStop { offset: s.offset, color: to_color(s.color).into() })
        .collect();
    let grad = match g.kind {
        GradientKind::Linear { x0, y0, x1, y1 } => {
            peniko::Gradient::new_linear((x0, y0), (x1, y1))
        }
        GradientKind::Radial { cx, cy, r, fx, fy, fr } => {
            let center = kurbo::Point::new(cx, cy);
            let focus = kurbo::Point::new(fx.unwrap_or(cx), fy.unwrap_or(cy));
            peniko::Gradient::new_two_point_radial(focus, fr.unwrap_or(0.0) as f32, center, r as f32)
        }
        GradientKind::Sweep { cx, cy, start_angle, end_angle } => {
            peniko::Gradient::new_sweep((cx, cy), start_angle, end_angle)
        }
    };
    grad.with_stops(stops.as_slice()).with_extend(to_extend(g.extend))
}

fn to_extend(e: Extend) -> peniko::Extend {
    match e {
        Extend::Pad => peniko::Extend::Pad,
        Extend::Repeat => peniko::Extend::Repeat,
        Extend::Reflect => peniko::Extend::Reflect,
    }
}

fn to_stroke(s: &StrokeStyle) -> Stroke {
    let mut stroke = Stroke::new(s.width)
        .with_join(match s.join {
            Join::Miter => KJoin::Miter,
            Join::Round => KJoin::Round,
            Join::Bevel => KJoin::Bevel,
        })
        .with_caps(match s.cap {
            Cap::Butt => KCap::Butt,
            Cap::Round => KCap::Round,
            Cap::Square => KCap::Square,
        })
        .with_miter_limit(s.miter_limit);
    if !s.dashes.is_empty() {
        stroke = stroke.with_dashes(s.dash_offset, s.dashes.iter().copied());
    }
    stroke
}

fn to_mix(m: Mix) -> peniko::Mix {
    use peniko::Mix as M;
    match m {
        Mix::Normal => M::Normal,
        Mix::Multiply => M::Multiply,
        Mix::Screen => M::Screen,
        Mix::Overlay => M::Overlay,
        Mix::Darken => M::Darken,
        Mix::Lighten => M::Lighten,
        Mix::ColorDodge => M::ColorDodge,
        Mix::ColorBurn => M::ColorBurn,
        Mix::HardLight => M::HardLight,
        Mix::SoftLight => M::SoftLight,
        Mix::Difference => M::Difference,
        Mix::Exclusion => M::Exclusion,
        Mix::Hue => M::Hue,
        Mix::Saturation => M::Saturation,
        Mix::Color => M::Color,
        Mix::Luminosity => M::Luminosity,
        Mix::Clip => M::Clip,
    }
}

fn to_compose(c: Compose) -> peniko::Compose {
    use peniko::Compose as C;
    match c {
        Compose::Clear => C::Clear,
        Compose::Copy => C::Copy,
        Compose::Dest => C::Dest,
        Compose::SrcOver => C::SrcOver,
        Compose::DestOver => C::DestOver,
        Compose::SrcIn => C::SrcIn,
        Compose::DestIn => C::DestIn,
        Compose::SrcOut => C::SrcOut,
        Compose::DestOut => C::DestOut,
        Compose::SrcAtop => C::SrcAtop,
        Compose::DestAtop => C::DestAtop,
        Compose::Xor => C::Xor,
        Compose::Plus => C::Plus,
    }
}

/// Build a kurbo path from a protocol [`Path`] (freeform elements or a primitive).
fn to_bez(path: &Path) -> BezPath {
    match path {
        Path::Elements { els } => {
            let mut bp = BezPath::new();
            for el in els {
                match *el {
                    PathEl::MoveTo { x, y } => bp.move_to((x, y)),
                    PathEl::LineTo { x, y } => bp.line_to((x, y)),
                    PathEl::QuadTo { cx, cy, x, y } => bp.quad_to((cx, cy), (x, y)),
                    PathEl::CurveTo { c1x, c1y, c2x, c2y, x, y } => {
                        bp.curve_to((c1x, c1y), (c2x, c2y), (x, y))
                    }
                    PathEl::ClosePath => bp.close_path(),
                }
            }
            bp
        }
        Path::Rect { x, y, w, h } => kurbo::Rect::new(*x, *y, *x + *w, *y + *h).into_path(0.1),
        Path::RoundRect { x, y, w, h, radius, radii } => {
            let r = kurbo::Rect::new(*x, *y, *x + *w, *y + *h);
            match radii {
                Some([tl, tr, br, bl]) => {
                    kurbo::RoundedRect::new(r.x0, r.y0, r.x1, r.y1,
                        (*tl, *tr, *br, *bl)).into_path(0.1)
                }
                None => kurbo::RoundedRect::from_rect(r, *radius).into_path(0.1),
            }
        }
        Path::Circle { cx, cy, r } => kurbo::Circle::new((*cx, *cy), *r).into_path(0.1),
        Path::Ellipse { cx, cy, rx, ry } => {
            kurbo::Ellipse::new((*cx, *cy), (*rx, *ry), 0.0).into_path(0.1)
        }
        Path::Line { x0, y0, x1, y1 } => {
            let mut bp = BezPath::new();
            bp.move_to((*x0, *y0));
            bp.line_to((*x1, *y1));
            bp
        }
    }
}
