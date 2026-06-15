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

use std::collections::HashMap;

use base64::Engine;
use wgpu::util::DeviceExt;

use elpa_protocol::command::{ColorAttachment, TargetView};
use elpa_protocol::resource::{
    BindingResource as PBindingResource, ResourceDesc, ResourceId,
};
use elpa_protocol::{ComputePass, EncoderCommand, Rect, RenderCommand, RenderPass};

use crate::backend::GpuBackend;

/// Holds the GPU and every realized resource. Generic over the surface lifetime.
pub struct WgpuBackend<'s> {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'s>,
    config: wgpu::SurfaceConfiguration,

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

    // Per-frame transient state.
    frame_texture: Option<wgpu::SurfaceTexture>,
    frame_view: Option<wgpu::TextureView>,
    encoder: Option<wgpu::CommandEncoder>,
}

impl<'s> WgpuBackend<'s> {
    /// Acquire an adapter+device for `surface` and configure it at `width×height`.
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'s>,
        width: u32,
        height: u32,
    ) -> WgpuBackend<'s> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("no compatible GPU adapter");

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("elpa-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                trace: wgpu::Trace::Off,
            })
            .await
            .expect("failed to create device");

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

        WgpuBackend {
            device,
            queue,
            surface,
            config,
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
            frame_texture: None,
            frame_view: None,
            encoder: None,
        }
    }

    /// The surface's configured color format (apps must match it in pipelines).
    pub fn surface_format(&self) -> wgpu::TextureFormat {
        self.config.format
    }

    /// Reconfigure the surface after a resize.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    /// Acquire the next swapchain texture, treating suboptimal as success.
    fn acquire(&self) -> Option<wgpu::SurfaceTexture> {
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => Some(t),
            _ => None,
        }
    }

    /// Resolve a `TargetView` to a concrete `&wgpu::TextureView`.
    fn resolve_view<'a>(&'a self, view: &TargetView) -> &'a wgpu::TextureView {
        match view {
            TargetView::Surface => self.frame_view.as_ref().expect("frame not begun"),
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
                    cache: None,
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
                    cache: None,
                });
                self.compute_pipelines.insert(d.id.clone(), pipeline);
            }
        }
    }

    fn update_buffer(&mut self, id: &str, offset: u64, bytes: &[u8]) {
        // Reuse the resident allocation; the cache only routes here when the
        // buffer exists at this size and declares COPY_DST.
        if let Some(buffer) = self.buffers.get(id) {
            self.queue.write_buffer(buffer, offset, bytes);
        }
    }

    fn destroy_resource(&mut self, id: &str) {
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
        let frame = match self.acquire() {
            Some(f) => f,
            None => {
                // Surface lost/outdated: reconfigure and try once more.
                self.surface.configure(&self.device, &self.config);
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
            for cmd in &pass.commands {
                self.replay_render_command(&mut rp, cmd);
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
            EncoderCommand::WriteBuffer { buffer, offset, data_b64 } => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).unwrap_or_default();
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
}

impl<'s> WgpuBackend<'s> {
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
