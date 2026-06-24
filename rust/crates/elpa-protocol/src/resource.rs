//! GPU **resource descriptors** — the declarative half of a frame.
//!
//! A [`Frame`](crate::Frame) carries a set of these; the renderer creates each
//! one on the real `wgpu::Device` and caches it by [`ResourceId`]. A resource is
//! only (re)created when its descriptor's content hash changes, so static
//! pipelines/buffers/textures are built once and reused for the app's lifetime.
//!
//! wgpu has *large* enums (formats, usages, blend factors, ...). To map the
//! entire surface without an enormous hand-maintained mirror, scalar enums are
//! carried as strings/`Vec<String>` bitflags and parsed at the backend (the one
//! place that links wgpu). This makes the JSON ⇆ wgpu mapping *total*: any valid
//! wgpu token passes through unchanged.

use serde::{Deserialize, Serialize};

use crate::geometry::Extent3d;

/// App-chosen stable identity for a GPU resource (e.g. `"sceneCamera"`,
/// `"quadPipeline"`). Used as the cache key and for cross-references.
pub type ResourceId = String;

/// A single resource declaration. Tagged by `"kind"` in JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResourceDesc {
    Buffer(BufferDesc),
    Texture(TextureDesc),
    Sampler(SamplerDesc),
    Shader(ShaderDesc),
    BindGroupLayout(BindGroupLayoutDesc),
    BindGroup(BindGroupDesc),
    PipelineLayout(PipelineLayoutDesc),
    RenderPipeline(RenderPipelineDesc),
    ComputePipeline(ComputePipelineDesc),
}

impl ResourceDesc {
    /// The id this descriptor declares (its cache key).
    pub fn id(&self) -> &ResourceId {
        match self {
            ResourceDesc::Buffer(d) => &d.id,
            ResourceDesc::Texture(d) => &d.id,
            ResourceDesc::Sampler(d) => &d.id,
            ResourceDesc::Shader(d) => &d.id,
            ResourceDesc::BindGroupLayout(d) => &d.id,
            ResourceDesc::BindGroup(d) => &d.id,
            ResourceDesc::PipelineLayout(d) => &d.id,
            ResourceDesc::RenderPipeline(d) => &d.id,
            ResourceDesc::ComputePipeline(d) => &d.id,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BufferDesc {
    pub id: ResourceId,
    pub size: u64,
    /// `wgpu::BufferUsages` flag names: `VERTEX`, `INDEX`, `UNIFORM`, `STORAGE`,
    /// `COPY_SRC`, `COPY_DST`, `INDIRECT`, `MAP_READ`, `MAP_WRITE`.
    pub usage: Vec<String>,
    /// Optional initial contents, base64-encoded; decoded at the backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_b64: Option<String>,
    /// Optional initial contents as a numeric array, packed little-endian at the
    /// backend. These let a VM program build geometry / instance / uniform data
    /// from plain number arrays — which the Elpian language expresses natively —
    /// without producing base64. At most one `data_*` field should be set; they
    /// are tried in order `data_b64`, `data_f32`, `data_u32`, `data_u16`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_f32: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_u32: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_u16: Option<Vec<u16>>,
}

impl BufferDesc {
    /// A buffer with no initial contents.
    pub fn new(id: impl Into<ResourceId>, size: u64, usage: Vec<String>) -> Self {
        Self { id: id.into(), size, usage, ..Default::default() }
    }

    /// The initial contents as little-endian bytes, from whichever `data_*`
    /// field is set (`None` => create the buffer uninitialized at `size`).
    pub fn init_bytes(&self) -> Option<Vec<u8>> {
        pack_le_bytes(
            self.data_b64.as_deref(),
            self.data_f32.as_deref(),
            self.data_u32.as_deref(),
            self.data_u16.as_deref(),
        )
    }
}

/// Resolve a `data_*` payload set into little-endian bytes, trying the fields in
/// order `b64`, `f32`, `u32`, `u16` (the first one set wins). Shared by buffer
/// initialization and `WriteBuffer` updates so both speak the same numeric
/// channel — a VM can stream typed number arrays straight to the GPU without
/// base64. Returns `None` when no payload is set.
pub fn pack_le_bytes(
    b64: Option<&str>,
    f32s: Option<&[f32]>,
    u32s: Option<&[u32]>,
    u16s: Option<&[u16]>,
) -> Option<Vec<u8>> {
    if let Some(b64) = b64 {
        return Some(decode_b64(b64));
    }
    if let Some(v) = f32s {
        return Some(v.iter().flat_map(|x| x.to_le_bytes()).collect());
    }
    if let Some(v) = u32s {
        return Some(v.iter().flat_map(|x| x.to_le_bytes()).collect());
    }
    if let Some(v) = u16s {
        return Some(v.iter().flat_map(|x| x.to_le_bytes()).collect());
    }
    None
}

/// Minimal standard-alphabet base64 decoder (no padding required) so the
/// protocol crate stays dependency-free; the backend uses [`BufferDesc::init_bytes`].
fn decode_b64(s: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        let Some(v) = val(c) else { continue }; // skip '=' and whitespace
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextureDesc {
    pub id: ResourceId,
    pub size: Extent3d,
    /// `wgpu::TextureFormat` token, e.g. `rgba8unorm-srgb`, `depth32float`.
    pub format: String,
    /// `wgpu::TextureUsages` names: `RENDER_ATTACHMENT`, `TEXTURE_BINDING`,
    /// `STORAGE_BINDING`, `COPY_SRC`, `COPY_DST`.
    pub usage: Vec<String>,
    #[serde(default = "one_u32")]
    pub mip_level_count: u32,
    #[serde(default = "one_u32")]
    pub sample_count: u32,
    /// `1d` | `2d` | `3d`.
    #[serde(default = "dim2")]
    pub dimension: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SamplerDesc {
    pub id: ResourceId,
    pub mag_filter: String,
    pub min_filter: String,
    pub mipmap_filter: String,
    pub address_mode_u: String,
    pub address_mode_v: String,
    pub address_mode_w: String,
    /// `wgpu::CompareFunction` for comparison/shadow samplers, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<String>,
}

impl Default for SamplerDesc {
    fn default() -> Self {
        Self {
            id: String::new(),
            mag_filter: "nearest".into(),
            min_filter: "nearest".into(),
            mipmap_filter: "nearest".into(),
            address_mode_u: "clamp-to-edge".into(),
            address_mode_v: "clamp-to-edge".into(),
            address_mode_w: "clamp-to-edge".into(),
            compare: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShaderDesc {
    pub id: ResourceId,
    /// WGSL source. The renderer compiles it into a `wgpu::ShaderModule`.
    pub wgsl: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindGroupLayoutDesc {
    pub id: ResourceId,
    pub entries: Vec<BindGroupLayoutEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindGroupLayoutEntry {
    pub binding: u32,
    /// `wgpu::ShaderStages` names: `VERTEX`, `FRAGMENT`, `COMPUTE`.
    pub visibility: Vec<String>,
    /// Binding type: `uniform` | `storage` | `read-only-storage` | `texture` |
    /// `storage-texture` | `sampler` | `comparison-sampler`.
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindGroupDesc {
    pub id: ResourceId,
    pub layout: ResourceId,
    pub entries: Vec<BindGroupEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindGroupEntry {
    pub binding: u32,
    pub resource: BindingResource,
}

impl BindGroupDesc {
    /// The resource ids this bind group binds (buffers, texture views, samplers).
    ///
    /// A bind group's *descriptor* is stable frame to frame, but a buffer it
    /// binds may be refilled in place (an animated uniform: camera, transforms).
    /// A pass that reads this bind group must therefore fold in these resources'
    /// content hashes — not just the bind group's own hash — to notice the change.
    pub fn bound_resources(&self) -> Vec<ResourceId> {
        self.entries
            .iter()
            .map(|e| match &e.resource {
                BindingResource::Buffer { buffer, .. } => buffer.clone(),
                BindingResource::TextureView { texture } => texture.clone(),
                BindingResource::Sampler { sampler } => sampler.clone(),
            })
            .collect()
    }
}

/// What a bind-group slot points at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BindingResource {
    Buffer {
        buffer: ResourceId,
        #[serde(default)]
        offset: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
    /// A view of a texture resource (the backend derives the `TextureView`).
    TextureView {
        texture: ResourceId,
    },
    Sampler {
        sampler: ResourceId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineLayoutDesc {
    pub id: ResourceId,
    pub bind_group_layouts: Vec<ResourceId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPipelineDesc {
    pub id: ResourceId,
    /// `None` => auto layout from the shaders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<ResourceId>,
    pub vertex: VertexState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment: Option<FragmentState>,
    #[serde(default)]
    pub primitive: PrimitiveState,
    /// Present for 3D / depth-tested 2D; `None` disables the depth-stencil test.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth_stencil: Option<DepthStencilState>,
    #[serde(default)]
    pub multisample: MultisampleState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VertexState {
    pub module: ResourceId,
    pub entry_point: String,
    #[serde(default)]
    pub buffers: Vec<VertexBufferLayout>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VertexBufferLayout {
    pub array_stride: u64,
    /// `vertex` | `instance`.
    #[serde(default = "vstep")]
    pub step_mode: String,
    pub attributes: Vec<VertexAttribute>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VertexAttribute {
    /// `wgpu::VertexFormat`, e.g. `float32x3`, `uint32`, `unorm8x4`.
    pub format: String,
    pub offset: u64,
    pub shader_location: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FragmentState {
    pub module: ResourceId,
    pub entry_point: String,
    pub targets: Vec<ColorTargetState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorTargetState {
    pub format: String,
    /// Blend state for alpha compositing / additive / multiply etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blend: Option<BlendState>,
    /// `wgpu::ColorWrites` mask names (`RED`,`GREEN`,`BLUE`,`ALPHA`,`ALL`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_mask: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlendState {
    pub color: BlendComponent,
    pub alpha: BlendComponent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlendComponent {
    /// `wgpu::BlendFactor` token (e.g. `src-alpha`, `one-minus-src-alpha`).
    pub src_factor: String,
    pub dst_factor: String,
    /// `wgpu::BlendOperation` token (e.g. `add`, `subtract`, `min`, `max`).
    pub operation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PrimitiveState {
    /// `point-list` | `line-list` | `line-strip` | `triangle-list` | `triangle-strip`.
    pub topology: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strip_index_format: Option<String>,
    /// `ccw` | `cw`.
    pub front_face: String,
    /// `none` | `front` | `back`.
    pub cull_mode: String,
}

impl Default for PrimitiveState {
    fn default() -> Self {
        Self {
            topology: "triangle-list".into(),
            strip_index_format: None,
            front_face: "ccw".into(),
            cull_mode: "none".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DepthStencilState {
    /// A depth format, e.g. `depth32float`, `depth24plus`.
    pub format: String,
    #[serde(default = "btrue")]
    pub depth_write_enabled: bool,
    /// `wgpu::CompareFunction`, e.g. `less`, `less-equal`, `always`.
    #[serde(default = "cmp_less")]
    pub depth_compare: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MultisampleState {
    pub count: u32,
    pub mask: u32,
    pub alpha_to_coverage_enabled: bool,
}

impl Default for MultisampleState {
    fn default() -> Self {
        Self { count: 1, mask: 0xFFFF_FFFF, alpha_to_coverage_enabled: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputePipelineDesc {
    pub id: ResourceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<ResourceId>,
    pub module: ResourceId,
    pub entry_point: String,
}

fn one_u32() -> u32 {
    1
}
fn dim2() -> String {
    "2d".into()
}
fn vstep() -> String {
    "vertex".into()
}
fn btrue() -> bool {
    true
}
fn cmp_less() -> String {
    "less".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_desc_roundtrips_and_reports_id() {
        let json = r#"{"kind":"buffer","id":"verts","size":4096,"usage":["VERTEX","COPY_DST"]}"#;
        let d: ResourceDesc = serde_json::from_str(json).unwrap();
        assert_eq!(d.id(), "verts");
        let back = serde_json::to_string(&d).unwrap();
        let d2: ResourceDesc = serde_json::from_str(&back).unwrap();
        assert_eq!(d, d2);
    }

    #[test]
    fn numeric_buffer_data_packs_little_endian() {
        // A buffer initialized from a float array (the path a VM program uses to
        // build geometry without base64).
        let json = r#"{"kind":"buffer","id":"vb","size":8,"usage":["VERTEX"],"data_f32":[1.0,-1.0]}"#;
        let d: ResourceDesc = serde_json::from_str(json).unwrap();
        match &d {
            ResourceDesc::Buffer(b) => {
                let bytes = b.init_bytes().unwrap();
                assert_eq!(bytes.len(), 8);
                assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
                assert_eq!(&bytes[4..8], &(-1.0f32).to_le_bytes());
            }
            _ => panic!("expected buffer"),
        }
        // Round-trips and omits the unset data fields.
        let back = serde_json::to_string(&d).unwrap();
        assert!(!back.contains("data_b64"));
        assert!(!back.contains("data_u16"));
        assert_eq!(serde_json::from_str::<ResourceDesc>(&back).unwrap(), d);
    }

    #[test]
    fn uint16_buffer_and_base64_round_trip_to_same_bytes() {
        let u16s = ResourceDesc::Buffer(BufferDesc {
            data_u16: Some(vec![0x0102, 0x0304]),
            ..BufferDesc::new("ib", 4, vec!["INDEX".into()])
        });
        match &u16s {
            ResourceDesc::Buffer(b) => {
                assert_eq!(b.init_bytes().unwrap(), vec![0x02, 0x01, 0x04, 0x03]);
            }
            _ => unreachable!(),
        }
        // The built-in base64 decoder matches a known encoding ("AQID" -> 1,2,3).
        let b64 = ResourceDesc::Buffer(BufferDesc {
            data_b64: Some("AQID".into()),
            ..BufferDesc::new("b", 3, vec!["VERTEX".into()])
        });
        match &b64 {
            ResourceDesc::Buffer(b) => assert_eq!(b.init_bytes().unwrap(), vec![1, 2, 3]),
            _ => unreachable!(),
        }
    }

    #[test]
    fn render_pipeline_with_depth_parses() {
        let json = r#"{
          "kind":"renderPipeline","id":"pbr","layout":"pbrLayout",
          "vertex":{"module":"shader","entry_point":"vs","buffers":[
            {"array_stride":32,"attributes":[{"format":"float32x3","offset":0,"shader_location":0}]}
          ]},
          "fragment":{"module":"shader","entry_point":"fs","targets":[{"format":"rgba8unorm-srgb"}]},
          "primitive":{"topology":"triangle-list","cull_mode":"back","front_face":"ccw"},
          "depth_stencil":{"format":"depth32float"}
        }"#;
        let d: ResourceDesc = serde_json::from_str(json).unwrap();
        match d {
            ResourceDesc::RenderPipeline(p) => {
                assert!(p.depth_stencil.is_some());
                assert_eq!(p.primitive.cull_mode, "back");
                assert_eq!(p.vertex.buffers[0].attributes[0].format, "float32x3");
            }
            _ => panic!("expected render pipeline"),
        }
    }
}
