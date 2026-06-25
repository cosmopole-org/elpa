//! The live **wgpu backend** — the real, one-to-one mapping from the
//! [`elpa_protocol`] command tree onto the wgpu API. This module is the only
//! place that links wgpu; it implements [`GpuBackend`](crate::GpuBackend) so the
//! cache / partial-render orchestrator drives it unchanged.
//!
//! It owns the GPU device/queue/surface and a cache of realized wgpu objects
//! keyed by [`ResourceId`]. `create_resource` builds a wgpu object from a
//! descriptor; `record_render_pass`/`record_compute_pass` replay the command
//! tree into a `wgpu::RenderPass`/`ComputePass`; `end_frame` submits & presents.
//!
//! String enum tokens in the protocol (formats, usages, blend factors, …) are
//! parsed here — see the `parse` helpers — which is what keeps the JSON⇆wgpu
//! mapping total without a giant hand-mirrored enum in the schema.
//!
//! Built only under the `wgpu-backend` feature.

use ahash::AHashMap as HashMap;
use xxhash_rust::xxh3::Xxh3;

use base64::Engine;
use wgpu::util::DeviceExt;

use elpa_protocol::command::{ColorAttachment, TargetView};
use elpa_protocol::resource::{
    BindingResource as PBindingResource, ResourceDesc, ResourceId,
};
use elpa_protocol::{ComputePass, EncoderCommand, Rect, RenderCommand, RenderPass};

use crate::backend::GpuBackend;

/// Where a backend presents each frame. Elpa renders the *same* command tree
/// either to a windowing-system swapchain ([`RenderTarget::Surface`] — the full
/// example apps, and the web canvas the Flutter `HtmlElementView` hosts) or
/// straight into a caller-owned [`wgpu::Texture`] ([`RenderTarget::Texture`] —
/// the zero-copy Flutter texture path, where the texture is imported from a
/// platform shared buffer and Flutter samples it inline). Only `begin_frame`,
/// `end_frame`, `resize`, and surface-view resolution branch on the variant; the
/// resource cache and command replay are identical.
enum RenderTarget<'s> {
    /// A windowing-system swapchain: each frame acquires an image and presents it.
    Surface { surface: wgpu::Surface<'s>, config: wgpu::SurfaceConfiguration },
    /// A caller-owned render-target texture: each frame renders into its view and
    /// submits — no present (the compositor samples the texture directly). `owned`
    /// records whether this backend created the texture (so a resize can recreate
    /// it) or merely borrowed an imported one (so a resize is the host's job — it
    /// re-imports and rebuilds the backend).
    Texture {
        texture: wgpu::Texture,
        view: wgpu::TextureView,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        owned: bool,
    },
}

/// Holds the GPU and every realized resource. Generic over the surface lifetime.
pub struct WgpuBackend<'s> {
    device: wgpu::Device,
    queue: wgpu::Queue,
    target: RenderTarget<'s>,

    buffers: HashMap<ResourceId, wgpu::Buffer>,
    textures: HashMap<ResourceId, wgpu::Texture>,
    views: HashMap<ResourceId, wgpu::TextureView>,
    samplers: HashMap<ResourceId, wgpu::Sampler>,
    shaders: HashMap<ResourceId, wgpu::ShaderModule>,
    bind_group_layouts: HashMap<ResourceId, wgpu::BindGroupLayout>,
    bind_groups: HashMap<ResourceId, wgpu::BindGroup>,
    pipeline_layouts: HashMap<ResourceId, wgpu::PipelineLayout>,
    render_pipelines: HashMap<ResourceId, wgpu::RenderPipeline>,
    compute_pipelines: HashMap<ResourceId, wgpu::ComputePipeline>,

    /// Pre-recorded draw sequences for stable, identified render passes, keyed by
    /// pass id. A pass whose command *structure* is unchanged replays its bundle
    /// instead of re-issuing every `set_*`/`draw` call — the per-frame CPU win
    /// for a busy surface pass whose buffers are refilled in place. Invalidated
    /// whenever any resource is (re)created or destroyed, since a bundle captures
    /// the GPU handles it references.
    render_bundles: HashMap<String, BundleEntry>,
    /// Driver pipeline-compilation cache (when the adapter exposes
    /// `PIPELINE_CACHE`). Threaded into every pipeline build so warm launches
    /// skip recompilation; the host can persist [`Self::pipeline_cache_data`]
    /// between runs.
    pipeline_cache: Option<wgpu::PipelineCache>,

    // Per-frame transient state.
    frame_texture: Option<wgpu::SurfaceTexture>,
    frame_view: Option<wgpu::TextureView>,
    encoder: Option<wgpu::CommandEncoder>,
}

/// A cached render bundle plus the structural fingerprint it was built for, so a
/// pass that changes shape (different draws/pipelines/formats) rebuilds it.
struct BundleEntry {
    struct_hash: u64,
    bundle: wgpu::RenderBundle,
}

impl<'s> WgpuBackend<'s> {
    /// Acquire an adapter+device for `surface` and configure it at `width×height`.
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'s>,
        width: u32,
        height: u32,
    ) -> WgpuBackend<'s> {
        Self::new_seeded(instance, surface, width, height, None).await
    }

    /// Like [`Self::new`], but seeds the driver pipeline cache from `cache_data`
    /// (a blob a prior run produced via [`Self::pipeline_cache_data`]). Warm
    /// launches then reuse compiled pipelines instead of recompiling shaders,
    /// cutting first-frame stalls. Ignored when the adapter lacks `PIPELINE_CACHE`.
    pub async fn new_seeded(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'s>,
        width: u32,
        height: u32,
        cache_data: Option<&[u8]>,
    ) -> WgpuBackend<'s> {
        Self::try_new_seeded(instance, surface, width, height, cache_data)
            .await
            .expect("no compatible GPU adapter/device")
    }

    /// Fallible swapchain constructor: returns `None` when no compatible GPU
    /// adapter/device is available (e.g. a headless browser with no WebGL/WebGPU
    /// context) instead of panicking, so a host can fall back to a 2D-only path
    /// rather than crash. [`Self::new`]/[`Self::new_seeded`] are the panicking
    /// wrappers for callers that require a surface.
    pub async fn try_new_seeded(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'s>,
        width: u32,
        height: u32,
        cache_data: Option<&[u8]>,
    ) -> Option<WgpuBackend<'s>> {
        let (adapter, device, queue, pipeline_cache) =
            Self::try_acquire_device(instance, Some(&surface), cache_data).await?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        Some(Self::assemble(device, queue, RenderTarget::Surface { surface, config }, pipeline_cache))
    }

    /// Build a backend that renders into a fresh, backend-owned render-target
    /// texture (no swapchain). Used when there is no window/canvas to present to —
    /// e.g. the zero-copy Flutter texture path before a platform shared texture is
    /// imported, or pure offscreen rendering. The texture is created
    /// `RENDER_ATTACHMENT | COPY_SRC | TEXTURE_BINDING` so it can be sampled,
    /// blitted, or read back. Take it with [`Self::target_texture`].
    pub async fn new_offscreen(
        instance: &wgpu::Instance,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> WgpuBackend<'s> {
        let (_adapter, device, queue, pipeline_cache) =
            Self::try_acquire_device(instance, None, None).await.expect("no compatible GPU device");
        let texture = Self::make_target_texture(&device, format, width, height);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let target = RenderTarget::Texture {
            texture,
            view,
            format,
            width: width.max(1),
            height: height.max(1),
            owned: true,
        };
        Self::assemble(device, queue, target, pipeline_cache)
    }

    /// Build a backend that renders into a **caller-supplied** texture — the
    /// zero-copy compositing path. The host imports a platform shared buffer
    /// (Android `AHardwareBuffer`, iOS/macOS `IOSurface`, Linux DMA-BUF, Windows
    /// DXGI handle) into a [`wgpu::Texture`] on its own `device`/`queue`, then
    /// hands the three here; Elpa renders every frame into that texture and the
    /// platform compositor (Flutter's `Texture` widget) samples the same memory
    /// with no copy. The texture must be created with `RENDER_ATTACHMENT` usage and
    /// a renderable `format`; the host owns its lifetime and re-imports on resize.
    pub fn from_imported_texture(
        device: wgpu::Device,
        queue: wgpu::Queue,
        texture: wgpu::Texture,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> WgpuBackend<'s> {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let target = RenderTarget::Texture {
            texture,
            view,
            format,
            width: width.max(1),
            height: height.max(1),
            owned: false,
        };
        Self::assemble(device, queue, target, None)
    }

    /// Request an adapter (optionally compatible with `surface`) and a device,
    /// opting into the driver pipeline-compilation cache when available. Shared by
    /// every constructor so device setup lives in one place. Returns `None` when
    /// no adapter/device can be obtained (the caller decides whether that is fatal).
    async fn try_acquire_device(
        instance: &wgpu::Instance,
        compatible_surface: Option<&wgpu::Surface<'_>>,
        cache_data: Option<&[u8]>,
    ) -> Option<(wgpu::Adapter, wgpu::Device, wgpu::Queue, Option<wgpu::PipelineCache>)> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface,
                force_fallback_adapter: false,
            })
            .await
            .ok()?;

        // Opt into the pipeline-compilation cache only when the adapter offers it.
        let mut required_features = wgpu::Features::empty();
        let has_pipeline_cache = adapter.features().contains(wgpu::Features::PIPELINE_CACHE);
        if has_pipeline_cache {
            required_features |= wgpu::Features::PIPELINE_CACHE;
        }

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("elpa-device"),
                required_features,
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                trace: wgpu::Trace::Off,
            })
            .await
            .ok()?;

        // Safety: `cache_data`, when present, is an opaque blob the caller obtained
        // from a previous `get_data` on a compatible device; wgpu validates it and
        // (with `fallback: true`) discards anything stale, so a bad/foreign blob
        // is safe — it just yields an empty cache.
        let pipeline_cache = has_pipeline_cache.then(|| unsafe {
            device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                label: Some("elpa-pipeline-cache"),
                data: cache_data,
                fallback: true,
            })
        });

        Some((adapter, device, queue, pipeline_cache))
    }

    /// Create a backend-owned render-target texture (renderable + sampleable +
    /// copy source), used by [`Self::new_offscreen`] and offscreen resizes.
    fn make_target_texture(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("elpa-target"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    /// Initialize the resource caches around an already-built device/queue/target.
    fn assemble(
        device: wgpu::Device,
        queue: wgpu::Queue,
        target: RenderTarget<'s>,
        pipeline_cache: Option<wgpu::PipelineCache>,
    ) -> WgpuBackend<'s> {
        WgpuBackend {
            device,
            queue,
            target,
            buffers: HashMap::new(),
            textures: HashMap::new(),
            views: HashMap::new(),
            samplers: HashMap::new(),
            shaders: HashMap::new(),
            bind_group_layouts: HashMap::new(),
            bind_groups: HashMap::new(),
            pipeline_layouts: HashMap::new(),
            render_pipelines: HashMap::new(),
            compute_pipelines: HashMap::new(),
            render_bundles: HashMap::new(),
            pipeline_cache,
            frame_texture: None,
            frame_view: None,
            encoder: None,
        }
    }

    /// The render-target texture, when this backend draws into one (the zero-copy
    /// / offscreen path). `None` for a swapchain surface. The host uses it to wire
    /// the texture to the compositor or to read it back.
    pub fn target_texture(&self) -> Option<&wgpu::Texture> {
        match &self.target {
            RenderTarget::Texture { texture, .. } => Some(texture),
            RenderTarget::Surface { .. } => None,
        }
    }

    /// Read the offscreen render-target texture back to CPU as tightly-packed
    /// `RGBA8` bytes (`width*height*4`, row-major, top-left origin). `None` for a
    /// swapchain target (a surface is presented, not read). Blocks on the GPU copy,
    /// so it is for tests / screenshots, not the hot path. The target's format must
    /// be a 4-byte RGBA/BGRA unorm (the offscreen default).
    pub fn read_target_rgba(&self) -> Option<Vec<u8>> {
        let (texture, w, h) = match &self.target {
            RenderTarget::Texture { texture, width, height, .. } => (texture, *width, *height),
            RenderTarget::Surface { .. } => return None,
        };
        // Buffer rows must be 256-byte aligned for texture->buffer copies.
        let unpadded = (w * 4) as usize;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
        let padded = unpadded.div_ceil(align) * align;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("elpa-readback"),
            size: (padded * h as usize) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc =
            self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded as u32),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
        let data = slice.get_mapped_range();
        let mut out = Vec::with_capacity(unpadded * h as usize);
        for row in 0..h as usize {
            let start = row * padded;
            out.extend_from_slice(&data[start..start + unpadded]);
        }
        drop(data);
        buffer.unmap();
        Some(out)
    }

    /// The configured color format apps must match in their pipelines (read by the
    /// app via `gpu.surfaceInfo`). Works for both a swapchain and a texture target.
    pub fn surface_format(&self) -> wgpu::TextureFormat {
        match &self.target {
            RenderTarget::Surface { config, .. } => config.format,
            RenderTarget::Texture { format, .. } => *format,
        }
    }

    /// The driver pipeline cache as an opaque blob, for the host to persist and
    /// feed back to [`Self::new_seeded`] on the next launch. `None` when the
    /// adapter does not support `PIPELINE_CACHE`.
    pub fn pipeline_cache_data(&self) -> Option<Vec<u8>> {
        self.pipeline_cache.as_ref().and_then(|c| c.get_data())
    }

    /// Reconfigure the render target after a resize. A swapchain is reconfigured
    /// in place; a backend-*owned* offscreen texture is recreated at the new size.
    /// An *imported* (host-owned) texture is left untouched — the host re-imports
    /// the platform shared buffer at the new size and rebuilds the backend, since
    /// only it can re-create the shared allocation Flutter composites.
    pub fn resize(&mut self, width: u32, height: u32) {
        let device = &self.device;
        match &mut self.target {
            RenderTarget::Surface { surface, config } => {
                config.width = width.max(1);
                config.height = height.max(1);
                surface.configure(device, config);
            }
            RenderTarget::Texture { texture, view, format, width: w, height: h, owned } => {
                *w = width.max(1);
                *h = height.max(1);
                if *owned {
                    let tex = Self::make_target_texture(device, *format, *w, *h);
                    *view = tex.create_view(&wgpu::TextureViewDescriptor::default());
                    *texture = tex;
                    self.render_bundles.clear();
                }
            }
        }
    }

    /// Acquire the next swapchain texture, treating suboptimal as success. Only
    /// meaningful for a [`RenderTarget::Surface`]; a texture target presents none.
    fn acquire(&self) -> Option<wgpu::SurfaceTexture> {
        let surface = match &self.target {
            RenderTarget::Surface { surface, .. } => surface,
            RenderTarget::Texture { .. } => return None,
        };
        match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => Some(t),
            _ => None,
        }
    }

    /// Resolve a `TargetView` to a concrete `&wgpu::TextureView`. A
    /// `TargetView::Surface` resolves to the swapchain image acquired this frame,
    /// or — for a texture target — to that target's persistent view.
    fn resolve_view<'a>(&'a self, view: &TargetView) -> &'a wgpu::TextureView {
        match view {
            TargetView::Surface => match &self.target {
                RenderTarget::Surface { .. } => {
                    self.frame_view.as_ref().expect("frame not begun")
                }
                RenderTarget::Texture { view, .. } => view,
            },
            TargetView::Texture { texture } => {
                self.views.get(texture).unwrap_or_else(|| panic!("unknown texture {texture}"))
            }
        }
    }

    fn color_ops(att: &ColorAttachment) -> wgpu::Operations<wgpu::Color> {
        let load = if att.load == "load" {
            wgpu::LoadOp::Load
        } else {
            let c = att.clear_color.unwrap_or(elpa_protocol::Color::TRANSPARENT);
            wgpu::LoadOp::Clear(wgpu::Color { r: c.r, g: c.g, b: c.b, a: c.a })
        };
        wgpu::Operations { load, store: if att.store { wgpu::StoreOp::Store } else { wgpu::StoreOp::Discard } }
    }
}

impl<'s> GpuBackend for WgpuBackend<'s> {
    fn create_resource(&mut self, desc: &ResourceDesc) {
        // A new/replaced GPU handle invalidates any bundle that captured the old
        // one; drop them all and let the next frame re-record what it still needs.
        self.render_bundles.clear();
        match desc {
            ResourceDesc::Buffer(d) => {
                let usage = parse::buffer_usage(&d.usage);
                // Initial contents may be base64 or a numeric array (packed
                // little-endian); `init_bytes` resolves whichever is set.
                let buffer = match d.init_bytes() {
                    Some(bytes) => {
                        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some(&d.id),
                            contents: &bytes,
                            usage,
                        })
                    }
                    None => self.device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some(&d.id),
                        size: d.size,
                        usage,
                        mapped_at_creation: false,
                    }),
                };
                self.buffers.insert(d.id.clone(), buffer);
            }
            ResourceDesc::Texture(d) => {
                let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(&d.id),
                    size: wgpu::Extent3d {
                        width: d.size.width,
                        height: d.size.height,
                        depth_or_array_layers: d.size.depth,
                    },
                    mip_level_count: d.mip_level_count,
                    sample_count: d.sample_count,
                    dimension: parse::texture_dimension(&d.dimension),
                    format: parse::texture_format(&d.format),
                    usage: parse::texture_usage(&d.usage),
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                self.views.insert(d.id.clone(), view);
                self.textures.insert(d.id.clone(), texture);
            }
            ResourceDesc::Sampler(d) => {
                let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
                    label: Some(&d.id),
                    address_mode_u: parse::address_mode(&d.address_mode_u),
                    address_mode_v: parse::address_mode(&d.address_mode_v),
                    address_mode_w: parse::address_mode(&d.address_mode_w),
                    mag_filter: parse::filter(&d.mag_filter),
                    min_filter: parse::filter(&d.min_filter),
                    mipmap_filter: parse::mipmap_filter(&d.mipmap_filter),
                    compare: d.compare.as_deref().map(parse::compare),
                    ..Default::default()
                });
                self.samplers.insert(d.id.clone(), sampler);
            }
            ResourceDesc::Shader(d) => {
                let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&d.id),
                    source: wgpu::ShaderSource::Wgsl(d.wgsl.as_str().into()),
                });
                self.shaders.insert(d.id.clone(), module);
            }
            ResourceDesc::BindGroupLayout(d) => {
                let entries: Vec<wgpu::BindGroupLayoutEntry> = d
                    .entries
                    .iter()
                    .map(|e| wgpu::BindGroupLayoutEntry {
                        binding: e.binding,
                        visibility: parse::shader_stages(&e.visibility),
                        ty: parse::binding_type(&e.ty),
                        count: None,
                    })
                    .collect();
                let bgl = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some(&d.id),
                    entries: &entries,
                });
                self.bind_group_layouts.insert(d.id.clone(), bgl);
            }
            ResourceDesc::BindGroup(d) => {
                let layout = self.bind_group_layouts.get(&d.layout).expect("bind group layout");
                let entries: Vec<wgpu::BindGroupEntry> = d
                    .entries
                    .iter()
                    .map(|e| wgpu::BindGroupEntry {
                        binding: e.binding,
                        resource: match &e.resource {
                            PBindingResource::Buffer { buffer, offset, size } => {
                                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                    buffer: self.buffers.get(buffer).expect("buffer"),
                                    offset: *offset,
                                    size: size.and_then(wgpu::BufferSize::new),
                                })
                            }
                            PBindingResource::TextureView { texture } => {
                                wgpu::BindingResource::TextureView(
                                    self.views.get(texture).expect("texture view"),
                                )
                            }
                            PBindingResource::Sampler { sampler } => wgpu::BindingResource::Sampler(
                                self.samplers.get(sampler).expect("sampler"),
                            ),
                        },
                    })
                    .collect();
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(&d.id),
                    layout,
                    entries: &entries,
                });
                self.bind_groups.insert(d.id.clone(), bg);
            }
            ResourceDesc::PipelineLayout(d) => {
                let layouts: Vec<Option<&wgpu::BindGroupLayout>> = d
                    .bind_group_layouts
                    .iter()
                    .map(|id| Some(self.bind_group_layouts.get(id).expect("bgl")))
                    .collect();
                let pl = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some(&d.id),
                    bind_group_layouts: &layouts,
                    immediate_size: 0,
                });
                self.pipeline_layouts.insert(d.id.clone(), pl);
            }
            ResourceDesc::RenderPipeline(d) => {
                let layout = d.layout.as_ref().map(|id| self.pipeline_layouts.get(id).expect("layout"));
                let vmodule = self.shaders.get(&d.vertex.module).expect("vertex shader");

                // Vertex buffer layouts must outlive the descriptor; build owned
                // attribute vectors first, then borrow.
                let attr_sets: Vec<Vec<wgpu::VertexAttribute>> = d
                    .vertex
                    .buffers
                    .iter()
                    .map(|b| {
                        b.attributes
                            .iter()
                            .map(|a| wgpu::VertexAttribute {
                                format: parse::vertex_format(&a.format),
                                offset: a.offset,
                                shader_location: a.shader_location,
                            })
                            .collect()
                    })
                    .collect();
                let vbuffers: Vec<wgpu::VertexBufferLayout> = d
                    .vertex
                    .buffers
                    .iter()
                    .zip(&attr_sets)
                    .map(|(b, attrs)| wgpu::VertexBufferLayout {
                        array_stride: b.array_stride,
                        step_mode: if b.step_mode == "instance" {
                            wgpu::VertexStepMode::Instance
                        } else {
                            wgpu::VertexStepMode::Vertex
                        },
                        attributes: attrs,
                    })
                    .collect();

                let fragment_targets: Vec<Option<wgpu::ColorTargetState>>;
                let fmodule;
                let fragment = if let Some(fs) = &d.fragment {
                    fmodule = self.shaders.get(&fs.module).expect("fragment shader");
                    fragment_targets = fs
                        .targets
                        .iter()
                        .map(|t| {
                            Some(wgpu::ColorTargetState {
                                format: parse::texture_format(&t.format),
                                blend: t.blend.as_ref().map(parse::blend_state),
                                write_mask: parse::color_writes(&t.write_mask),
                            })
                        })
                        .collect();
                    Some(wgpu::FragmentState {
                        module: fmodule,
                        entry_point: Some(&fs.entry_point),
                        compilation_options: Default::default(),
                        targets: &fragment_targets,
                    })
                } else {
                    None
                };

                let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(&d.id),
                    layout,
                    vertex: wgpu::VertexState {
                        module: vmodule,
                        entry_point: Some(&d.vertex.entry_point),
                        compilation_options: Default::default(),
                        buffers: &vbuffers,
                    },
                    primitive: parse::primitive(&d.primitive),
                    depth_stencil: d.depth_stencil.as_ref().map(parse::depth_stencil),
                    multisample: wgpu::MultisampleState {
                        count: d.multisample.count,
                        mask: d.multisample.mask as u64,
                        alpha_to_coverage_enabled: d.multisample.alpha_to_coverage_enabled,
                    },
                    fragment,
                    multiview_mask: None,
                    cache: self.pipeline_cache.as_ref(),
                });
                self.render_pipelines.insert(d.id.clone(), pipeline);
            }
            ResourceDesc::ComputePipeline(d) => {
                let layout = d.layout.as_ref().map(|id| self.pipeline_layouts.get(id).expect("layout"));
                let module = self.shaders.get(&d.module).expect("compute shader");
                let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(&d.id),
                    layout,
                    module,
                    entry_point: Some(&d.entry_point),
                    compilation_options: Default::default(),
                    cache: self.pipeline_cache.as_ref(),
                });
                self.compute_pipelines.insert(d.id.clone(), pipeline);
            }
        }
    }

    fn update_buffer(&mut self, id: &str, offset: u64, bytes: &[u8]) {
        // Reuse the resident allocation; the cache only routes here when the
        // buffer exists at this size and declares COPY_DST. Bundles that bind this
        // buffer stay valid — the handle is unchanged, only its contents move — so
        // a recorded surface pass keeps replaying across animation frames.
        if let Some(buffer) = self.buffers.get(id) {
            self.queue.write_buffer(buffer, offset, bytes);
        }
    }

    fn destroy_resource(&mut self, id: &str) {
        self.render_bundles.clear();
        self.buffers.remove(id);
        self.textures.remove(id);
        self.views.remove(id);
        self.samplers.remove(id);
        self.shaders.remove(id);
        self.bind_group_layouts.remove(id);
        self.bind_groups.remove(id);
        self.pipeline_layouts.remove(id);
        self.render_pipelines.remove(id);
        self.compute_pipelines.remove(id);
    }

    fn begin_frame(&mut self) {
        // A texture target has a persistent view (resolved in `resolve_view`); it
        // needs no swapchain acquire, only a fresh encoder.
        if let RenderTarget::Surface { surface, config } = &self.target {
            let frame = match self.acquire() {
                Some(f) => f,
                None => {
                    // Surface lost/outdated: reconfigure and try once more.
                    surface.configure(&self.device, config);
                    match self.acquire() {
                        Some(f) => f,
                        None => {
                            // Skip this frame; record_* and end_frame are no-ops
                            // while there is no encoder.
                            self.encoder = None;
                            self.frame_texture = None;
                            self.frame_view = None;
                            return;
                        }
                    }
                }
            };
            let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.frame_view = Some(view);
            self.frame_texture = Some(frame);
        }
        self.encoder = Some(
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("elpa-frame") }),
        );
    }

    fn record_render_pass(&mut self, pass: &RenderPass) {
        // Take the encoder out so resource lookups can borrow `&self` freely.
        let mut encoder = match self.encoder.take() {
            Some(e) => e,
            None => return, // frame was skipped (surface unavailable)
        };

        // Build (or reuse) a pre-recorded bundle for this pass's draws. `Some(id)`
        // means we replay the cached bundle instead of re-issuing every command.
        let bundle_id = self.ensure_bundle(pass);

        let color_views: Vec<&wgpu::TextureView> =
            pass.color_attachments.iter().map(|a| self.resolve_view(&a.view)).collect();
        let color_attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = pass
            .color_attachments
            .iter()
            .zip(&color_views)
            .map(|(att, view)| {
                Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: att
                        .resolve_target
                        .as_ref()
                        .map(|id| self.views.get(id).expect("resolve view")),
                    ops: Self::color_ops(att),
                    depth_slice: None,
                })
            })
            .collect();

        let depth_view = pass.depth_stencil.as_ref().map(|d| self.views.get(&d.view).expect("depth view"));
        let depth_attachment = pass.depth_stencil.as_ref().zip(depth_view).map(|(d, view)| {
            wgpu::RenderPassDepthStencilAttachment {
                view,
                depth_ops: Some(wgpu::Operations {
                    load: if d.depth_load == "load" {
                        wgpu::LoadOp::Load
                    } else {
                        wgpu::LoadOp::Clear(d.depth_clear)
                    },
                    store: if d.depth_store { wgpu::StoreOp::Store } else { wgpu::StoreOp::Discard },
                }),
                stencil_ops: None,
            }
        });

        {
            let mut rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &color_attachments,
                depth_stencil_attachment: depth_attachment,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            match &bundle_id {
                Some(id) => {
                    rp.execute_bundles(std::iter::once(&self.render_bundles[id].bundle));
                }
                None => {
                    for cmd in &pass.commands {
                        self.replay_render_command(&mut rp, cmd);
                    }
                }
            }
        }

        self.encoder = Some(encoder);
    }

    fn record_compute_pass(&mut self, pass: &ComputePass) {
        let mut encoder = match self.encoder.take() {
            Some(e) => e,
            None => return,
        };
        {
            let mut cp = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            for cmd in &pass.commands {
                use elpa_protocol::ComputeCommand as C;
                match cmd {
                    C::SetPipeline { pipeline } => {
                        cp.set_pipeline(self.compute_pipelines.get(pipeline).expect("compute pipeline"));
                    }
                    C::SetBindGroup { index, bind_group, dynamic_offsets } => {
                        cp.set_bind_group(
                            *index,
                            Some(self.bind_groups.get(bind_group).expect("bind group")),
                            dynamic_offsets,
                        );
                    }
                    C::Dispatch { x, y, z } => cp.dispatch_workgroups(*x, *y, *z),
                    C::DispatchIndirect { buffer, offset } => {
                        cp.dispatch_workgroups_indirect(
                            self.buffers.get(buffer).expect("indirect buffer"),
                            *offset,
                        );
                    }
                }
            }
        }
        self.encoder = Some(encoder);
    }

    fn record_encoder_command(&mut self, cmd: &EncoderCommand) {
        let encoder = match self.encoder.as_mut() {
            Some(e) => e,
            None => return,
        };
        match cmd {
            EncoderCommand::CopyBufferToBuffer { src, src_offset, dst, dst_offset, size } => {
                encoder.copy_buffer_to_buffer(
                    self.buffers.get(src).expect("src"),
                    *src_offset,
                    self.buffers.get(dst).expect("dst"),
                    *dst_offset,
                    *size,
                );
            }
            EncoderCommand::ClearBuffer { buffer, offset, size } => {
                encoder.clear_buffer(self.buffers.get(buffer).expect("buffer"), *offset, *size);
            }
            EncoderCommand::WriteBuffer { buffer, offset, data_b64, data_f32, data_u32, data_u16 } => {
                let bytes = elpa_protocol::resource::pack_le_bytes(
                    data_b64.as_deref(),
                    data_f32.as_deref(),
                    data_u32.as_deref(),
                    data_u16.as_deref(),
                )
                .unwrap_or_default();
                self.queue.write_buffer(self.buffers.get(buffer).expect("buffer"), *offset, &bytes);
            }
            EncoderCommand::WriteTexture { texture, origin, size, data_b64 } => {
                let bytes =
                    base64::engine::general_purpose::STANDARD.decode(data_b64).unwrap_or_default();
                let tex = self.textures.get(texture).expect("texture");
                // Bytes per row from the texture's own format (e.g. 1 for r8unorm).
                let bpp = tex.format().block_copy_size(None).unwrap_or(4);
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: tex,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: origin.x, y: origin.y, z: origin.z },
                        aspect: wgpu::TextureAspect::All,
                    },
                    &bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(size.width * bpp),
                        rows_per_image: Some(size.height),
                    },
                    wgpu::Extent3d {
                        width: size.width,
                        height: size.height,
                        depth_or_array_layers: 1,
                    },
                );
            }
            // Remaining texture copies are left to a later milestone (they require
            // BUFFER↔TEXTURE layout plumbing).
            _ => {}
        }
    }

    fn end_frame(&mut self, _dirty: &[Rect]) {
        if let Some(encoder) = self.encoder.take() {
            self.queue.submit(std::iter::once(encoder.finish()));
        }
        self.frame_view = None;
        if let Some(frame) = self.frame_texture.take() {
            frame.present();
        }
    }

    /// Map the live surface format to its protocol token so apps can target it
    /// exactly. Covers the formats a swapchain commonly hands back; anything
    /// else falls back to `"bgra8unorm"` (the renderer-wide default).
    fn surface_format_token(&self) -> String {
        use wgpu::TextureFormat as F;
        match self.surface_format() {
            F::Bgra8Unorm => "bgra8unorm",
            F::Bgra8UnormSrgb => "bgra8unorm-srgb",
            F::Rgba8Unorm => "rgba8unorm",
            F::Rgba8UnormSrgb => "rgba8unorm-srgb",
            _ => "bgra8unorm",
        }
        .to_string()
    }

    /// The configured render-target size in physical pixels — the swapchain's
    /// dimensions (web canvas / window) or the imported texture's (the zero-copy
    /// native-widget path). Apps size their depth target / projection to this so
    /// they match the surface this backend actually draws into, not the host
    /// window (see [`GpuBackend::surface_size`]).
    fn surface_size(&self) -> Option<(u32, u32)> {
        Some(match &self.target {
            RenderTarget::Surface { config, .. } => (config.width, config.height),
            RenderTarget::Texture { width, height, .. } => (*width, *height),
        })
    }
}

impl<'s> WgpuBackend<'s> {
    /// Whether a render command can live inside a render bundle. Bundles support
    /// the pipeline/bind/buffer/draw subset only — dynamic state (scissor,
    /// viewport, blend constant, stencil ref) cannot be recorded, so a pass using
    /// any of it is replayed directly instead.
    fn bundle_compatible(cmd: &RenderCommand) -> bool {
        matches!(
            cmd,
            RenderCommand::SetPipeline { .. }
                | RenderCommand::SetBindGroup { .. }
                | RenderCommand::SetVertexBuffer { .. }
                | RenderCommand::SetIndexBuffer { .. }
                | RenderCommand::Draw { .. }
                | RenderCommand::DrawIndexed { .. }
                | RenderCommand::DrawIndirect { .. }
                | RenderCommand::DrawIndexedIndirect { .. }
        )
    }

    /// The color formats + sample count a bundle for `pass` must declare (it must
    /// match the render pass it executes in). `None` if a referenced target is not
    /// resident yet. Depth passes are excluded by the caller, so no depth here.
    fn bundle_color_targets(&self, pass: &RenderPass) -> Option<(Vec<wgpu::TextureFormat>, u32)> {
        let mut formats = Vec::with_capacity(pass.color_attachments.len());
        let mut sample_count = 1;
        for att in &pass.color_attachments {
            match &att.view {
                TargetView::Surface => formats.push(self.surface_format()),
                TargetView::Texture { texture } => {
                    let tex = self.textures.get(texture)?;
                    formats.push(tex.format());
                    sample_count = tex.sample_count();
                }
            }
        }
        Some((formats, sample_count))
    }

    /// Ensure a render bundle exists for an identified, bundle-eligible pass and
    /// return its id (so the caller replays it). Rebuilds it when the pass's
    /// structure or target formats change; returns `None` for passes that are not
    /// bundle-eligible (no id, depth attachment, or dynamic-state commands), which
    /// are replayed command-by-command as before.
    fn ensure_bundle(&mut self, pass: &RenderPass) -> Option<String> {
        let id = pass.id.clone()?;
        if pass.depth_stencil.is_some() || !pass.commands.iter().all(Self::bundle_compatible) {
            self.render_bundles.remove(&id);
            return None;
        }
        let (formats, sample_count) = self.bundle_color_targets(pass)?;

        // Structural fingerprint: the commands (which carry no buffer *contents*,
        // so an in-place data refill leaves it unchanged) plus the target formats.
        let mut h = Xxh3::new();
        h.update(&crate::cache::content_hash(&pass.commands).to_le_bytes());
        for f in &formats {
            h.update(format!("{f:?}").as_bytes());
            h.update(b"\x00");
        }
        h.update(&(sample_count as u64).to_le_bytes());
        let struct_hash = h.digest();

        if self.render_bundles.get(&id).map(|e| e.struct_hash) == Some(struct_hash) {
            return Some(id);
        }

        let color_formats: Vec<Option<wgpu::TextureFormat>> =
            formats.iter().map(|f| Some(*f)).collect();
        let mut be = self.device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: Some(&id),
            color_formats: &color_formats,
            depth_stencil: None,
            sample_count,
            multiview: None,
        });
        for cmd in &pass.commands {
            self.replay_into_bundle(&mut be, cmd);
        }
        let bundle = be.finish(&wgpu::RenderBundleDescriptor { label: Some(&id) });
        self.render_bundles.insert(id.clone(), BundleEntry { struct_hash, bundle });
        Some(id)
    }

    /// Replay one (bundle-compatible) command into a render bundle encoder.
    fn replay_into_bundle<'p>(
        &'p self,
        be: &mut wgpu::RenderBundleEncoder<'p>,
        cmd: &RenderCommand,
    ) {
        match cmd {
            RenderCommand::SetPipeline { pipeline } => {
                be.set_pipeline(self.render_pipelines.get(pipeline).expect("render pipeline"));
            }
            RenderCommand::SetBindGroup { index, bind_group, dynamic_offsets } => {
                be.set_bind_group(
                    *index,
                    Some(self.bind_groups.get(bind_group).expect("bind group")),
                    dynamic_offsets,
                );
            }
            RenderCommand::SetVertexBuffer { slot, buffer, offset } => {
                let vbuf = self.buffers.get(buffer).expect("vbuf");
                // `Buffer::slice(offset..)` panics on an empty range, and wgpu
                // forbids a zero-sized buffer binding. An empty vertex buffer (a
                // layer/scope with no instances this frame) carries no geometry, so
                // skip the bind entirely — the matching `draw` is a no-op too.
                if vbuf.size() > *offset {
                    be.set_vertex_buffer(*slot, vbuf.slice(*offset..));
                }
            }
            RenderCommand::SetIndexBuffer { buffer, format, offset } => {
                let ibuf = self.buffers.get(buffer).expect("ibuf");
                if ibuf.size() > *offset {
                    let fmt = if format == "uint16" {
                        wgpu::IndexFormat::Uint16
                    } else {
                        wgpu::IndexFormat::Uint32
                    };
                    be.set_index_buffer(ibuf.slice(*offset..), fmt);
                }
            }
            RenderCommand::Draw { vertex_count, instance_count, first_vertex, first_instance } => {
                // An empty draw (no vertices or no instances) does nothing; skip it
                // so an unbound/empty vertex buffer never reaches a draw call.
                if *vertex_count > 0 && *instance_count > 0 {
                    be.draw(
                        *first_vertex..*first_vertex + *vertex_count,
                        *first_instance..*first_instance + *instance_count,
                    );
                }
            }
            RenderCommand::DrawIndexed {
                index_count,
                instance_count,
                first_index,
                base_vertex,
                first_instance,
            } => {
                if *index_count > 0 && *instance_count > 0 {
                    be.draw_indexed(
                        *first_index..*first_index + *index_count,
                        *base_vertex,
                        *first_instance..*first_instance + *instance_count,
                    );
                }
            }
            RenderCommand::DrawIndirect { buffer, offset } => {
                be.draw_indirect(self.buffers.get(buffer).expect("indirect"), *offset);
            }
            RenderCommand::DrawIndexedIndirect { buffer, offset } => {
                be.draw_indexed_indirect(self.buffers.get(buffer).expect("indirect"), *offset);
            }
            // The caller only routes bundle-compatible commands here.
            _ => {}
        }
    }

    fn replay_render_command<'p>(&'p self, rp: &mut wgpu::RenderPass<'p>, cmd: &RenderCommand) {
        match cmd {
            RenderCommand::SetPipeline { pipeline } => {
                rp.set_pipeline(self.render_pipelines.get(pipeline).expect("render pipeline"));
            }
            RenderCommand::SetBindGroup { index, bind_group, dynamic_offsets } => {
                rp.set_bind_group(
                    *index,
                    Some(self.bind_groups.get(bind_group).expect("bind group")),
                    dynamic_offsets,
                );
            }
            RenderCommand::SetVertexBuffer { slot, buffer, offset } => {
                rp.set_vertex_buffer(*slot, self.buffers.get(buffer).expect("vbuf").slice(*offset..));
            }
            RenderCommand::SetIndexBuffer { buffer, format, offset } => {
                let fmt = if format == "uint16" {
                    wgpu::IndexFormat::Uint16
                } else {
                    wgpu::IndexFormat::Uint32
                };
                rp.set_index_buffer(self.buffers.get(buffer).expect("ibuf").slice(*offset..), fmt);
            }
            RenderCommand::Draw { vertex_count, instance_count, first_vertex, first_instance } => {
                rp.draw(
                    *first_vertex..*first_vertex + *vertex_count,
                    *first_instance..*first_instance + *instance_count,
                );
            }
            RenderCommand::DrawIndexed {
                index_count,
                instance_count,
                first_index,
                base_vertex,
                first_instance,
            } => {
                rp.draw_indexed(
                    *first_index..*first_index + *index_count,
                    *base_vertex,
                    *first_instance..*first_instance + *instance_count,
                );
            }
            RenderCommand::DrawIndirect { buffer, offset } => {
                rp.draw_indirect(self.buffers.get(buffer).expect("indirect"), *offset);
            }
            RenderCommand::DrawIndexedIndirect { buffer, offset } => {
                rp.draw_indexed_indirect(self.buffers.get(buffer).expect("indirect"), *offset);
            }
            RenderCommand::SetScissorRect { rect } => {
                rp.set_scissor_rect(rect.x, rect.y, rect.w, rect.h);
            }
            RenderCommand::SetViewport { x, y, w, h, min_depth, max_depth } => {
                rp.set_viewport(*x, *y, *w, *h, *min_depth, *max_depth);
            }
            RenderCommand::SetBlendConstant { color } => {
                rp.set_blend_constant(wgpu::Color { r: color.r, g: color.g, b: color.b, a: color.a });
            }
            RenderCommand::SetStencilReference { reference } => rp.set_stencil_reference(*reference),
            // Definition references are expanded by the host's definition store
            // before a frame reaches the backend; a leftover one is a no-op.
            RenderCommand::UseDefinition { .. } => {}
        }
    }
}

/// String-token → wgpu enum parsers. Unknown tokens panic with a clear message
/// (a malformed command tree is a program error, surfaced loudly during dev).
mod parse {
    pub fn buffer_usage(flags: &[String]) -> wgpu::BufferUsages {
        let mut u = wgpu::BufferUsages::empty();
        for f in flags {
            u |= match f.as_str() {
                "VERTEX" => wgpu::BufferUsages::VERTEX,
                "INDEX" => wgpu::BufferUsages::INDEX,
                "UNIFORM" => wgpu::BufferUsages::UNIFORM,
                "STORAGE" => wgpu::BufferUsages::STORAGE,
                "INDIRECT" => wgpu::BufferUsages::INDIRECT,
                "COPY_SRC" => wgpu::BufferUsages::COPY_SRC,
                "COPY_DST" => wgpu::BufferUsages::COPY_DST,
                "MAP_READ" => wgpu::BufferUsages::MAP_READ,
                "MAP_WRITE" => wgpu::BufferUsages::MAP_WRITE,
                other => panic!("unknown buffer usage {other}"),
            };
        }
        u
    }

    pub fn texture_usage(flags: &[String]) -> wgpu::TextureUsages {
        let mut u = wgpu::TextureUsages::empty();
        for f in flags {
            u |= match f.as_str() {
                "RENDER_ATTACHMENT" => wgpu::TextureUsages::RENDER_ATTACHMENT,
                "TEXTURE_BINDING" => wgpu::TextureUsages::TEXTURE_BINDING,
                "STORAGE_BINDING" => wgpu::TextureUsages::STORAGE_BINDING,
                "COPY_SRC" => wgpu::TextureUsages::COPY_SRC,
                "COPY_DST" => wgpu::TextureUsages::COPY_DST,
                other => panic!("unknown texture usage {other}"),
            };
        }
        u
    }

    pub fn texture_format(s: &str) -> wgpu::TextureFormat {
        use wgpu::TextureFormat as F;
        match s {
            "r8unorm" => F::R8Unorm,
            "rg8unorm" => F::Rg8Unorm,
            "rgba8unorm" => F::Rgba8Unorm,
            "rgba8unorm-srgb" => F::Rgba8UnormSrgb,
            "bgra8unorm" => F::Bgra8Unorm,
            "bgra8unorm-srgb" => F::Bgra8UnormSrgb,
            "rgba16float" => F::Rgba16Float,
            "rgba32float" => F::Rgba32Float,
            "depth32float" => F::Depth32Float,
            "depth24plus" => F::Depth24Plus,
            "depth24plus-stencil8" => F::Depth24PlusStencil8,
            other => panic!("unknown texture format {other}"),
        }
    }

    pub fn texture_dimension(s: &str) -> wgpu::TextureDimension {
        match s {
            "1d" => wgpu::TextureDimension::D1,
            "3d" => wgpu::TextureDimension::D3,
            _ => wgpu::TextureDimension::D2,
        }
    }

    pub fn vertex_format(s: &str) -> wgpu::VertexFormat {
        use wgpu::VertexFormat as V;
        match s {
            "float32" => V::Float32,
            "float32x2" => V::Float32x2,
            "float32x3" => V::Float32x3,
            "float32x4" => V::Float32x4,
            "uint32" => V::Uint32,
            "uint32x2" => V::Uint32x2,
            "uint32x4" => V::Uint32x4,
            "sint32" => V::Sint32,
            "unorm8x4" => V::Unorm8x4,
            other => panic!("unknown vertex format {other}"),
        }
    }

    pub fn primitive(p: &elpa_protocol::resource::PrimitiveState) -> wgpu::PrimitiveState {
        let topology = match p.topology.as_str() {
            "point-list" => wgpu::PrimitiveTopology::PointList,
            "line-list" => wgpu::PrimitiveTopology::LineList,
            "line-strip" => wgpu::PrimitiveTopology::LineStrip,
            "triangle-strip" => wgpu::PrimitiveTopology::TriangleStrip,
            _ => wgpu::PrimitiveTopology::TriangleList,
        };
        let front_face =
            if p.front_face == "cw" { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw };
        let cull_mode = match p.cull_mode.as_str() {
            "front" => Some(wgpu::Face::Front),
            "back" => Some(wgpu::Face::Back),
            _ => None,
        };
        wgpu::PrimitiveState {
            topology,
            strip_index_format: p.strip_index_format.as_deref().map(|f| {
                if f == "uint16" {
                    wgpu::IndexFormat::Uint16
                } else {
                    wgpu::IndexFormat::Uint32
                }
            }),
            front_face,
            cull_mode,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        }
    }

    pub fn depth_stencil(d: &elpa_protocol::resource::DepthStencilState) -> wgpu::DepthStencilState {
        wgpu::DepthStencilState {
            format: texture_format(&d.format),
            depth_write_enabled: Some(d.depth_write_enabled),
            depth_compare: Some(compare(&d.depth_compare)),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }
    }

    pub fn blend_state(b: &elpa_protocol::resource::BlendState) -> wgpu::BlendState {
        wgpu::BlendState { color: blend_component(&b.color), alpha: blend_component(&b.alpha) }
    }

    fn blend_component(c: &elpa_protocol::resource::BlendComponent) -> wgpu::BlendComponent {
        wgpu::BlendComponent {
            src_factor: blend_factor(&c.src_factor),
            dst_factor: blend_factor(&c.dst_factor),
            operation: match c.operation.as_str() {
                "subtract" => wgpu::BlendOperation::Subtract,
                "reverse-subtract" => wgpu::BlendOperation::ReverseSubtract,
                "min" => wgpu::BlendOperation::Min,
                "max" => wgpu::BlendOperation::Max,
                _ => wgpu::BlendOperation::Add,
            },
        }
    }

    fn blend_factor(s: &str) -> wgpu::BlendFactor {
        use wgpu::BlendFactor as B;
        match s {
            "zero" => B::Zero,
            "one" => B::One,
            "src" | "src-color" => B::Src,
            "one-minus-src" | "one-minus-src-color" => B::OneMinusSrc,
            "src-alpha" => B::SrcAlpha,
            "one-minus-src-alpha" => B::OneMinusSrcAlpha,
            "dst" | "dst-color" => B::Dst,
            "one-minus-dst" => B::OneMinusDst,
            "dst-alpha" => B::DstAlpha,
            "one-minus-dst-alpha" => B::OneMinusDstAlpha,
            other => panic!("unknown blend factor {other}"),
        }
    }

    pub fn color_writes(flags: &[String]) -> wgpu::ColorWrites {
        if flags.is_empty() {
            return wgpu::ColorWrites::ALL;
        }
        let mut w = wgpu::ColorWrites::empty();
        for f in flags {
            w |= match f.as_str() {
                "RED" => wgpu::ColorWrites::RED,
                "GREEN" => wgpu::ColorWrites::GREEN,
                "BLUE" => wgpu::ColorWrites::BLUE,
                "ALPHA" => wgpu::ColorWrites::ALPHA,
                "ALL" => wgpu::ColorWrites::ALL,
                other => panic!("unknown color write {other}"),
            };
        }
        w
    }

    pub fn shader_stages(flags: &[String]) -> wgpu::ShaderStages {
        let mut s = wgpu::ShaderStages::empty();
        for f in flags {
            s |= match f.as_str() {
                "VERTEX" => wgpu::ShaderStages::VERTEX,
                "FRAGMENT" => wgpu::ShaderStages::FRAGMENT,
                "COMPUTE" => wgpu::ShaderStages::COMPUTE,
                other => panic!("unknown shader stage {other}"),
            };
        }
        s
    }

    pub fn binding_type(s: &str) -> wgpu::BindingType {
        match s {
            "uniform" => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            "storage" => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: false },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            "read-only-storage" => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            "texture" => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            "sampler" => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            "comparison-sampler" => {
                wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison)
            }
            other => panic!("unknown binding type {other}"),
        }
    }

    pub fn filter(s: &str) -> wgpu::FilterMode {
        if s == "linear" {
            wgpu::FilterMode::Linear
        } else {
            wgpu::FilterMode::Nearest
        }
    }

    pub fn mipmap_filter(s: &str) -> wgpu::MipmapFilterMode {
        if s == "linear" {
            wgpu::MipmapFilterMode::Linear
        } else {
            wgpu::MipmapFilterMode::Nearest
        }
    }

    pub fn address_mode(s: &str) -> wgpu::AddressMode {
        match s {
            "repeat" => wgpu::AddressMode::Repeat,
            "mirror-repeat" => wgpu::AddressMode::MirrorRepeat,
            _ => wgpu::AddressMode::ClampToEdge,
        }
    }

    pub fn compare(s: &str) -> wgpu::CompareFunction {
        use wgpu::CompareFunction as C;
        match s {
            "never" => C::Never,
            "less" => C::Less,
            "equal" => C::Equal,
            "less-equal" => C::LessEqual,
            "greater" => C::Greater,
            "not-equal" => C::NotEqual,
            "greater-equal" => C::GreaterEqual,
            _ => C::Always,
        }
    }
}
