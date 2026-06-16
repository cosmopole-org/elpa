//! The **wgpu command tree** — the imperative half of a frame.
//!
//! A [`Frame`] is exactly what the VM submits via `gpu.submit`: the resources it
//! needs plus an ordered list of encoder-level commands (render passes, compute
//! passes, copies, queue writes). Render/compute passes nest their own command
//! lists. The renderer walks this tree and issues the corresponding wgpu calls,
//! one-to-one, in real time.
//!
//! This is deliberately a faithful mirror of `wgpu`'s `CommandEncoder` /
//! `RenderPass` / `ComputePass` surface — *not* a higher-level drawing model. 2D
//! and 3D are the same commands with different pipelines/shaders.

use serde::{Deserialize, Serialize};

use crate::geometry::{Color, Extent3d, Origin3d, Rect};
use crate::resource::{ResourceDesc, ResourceId};

/// A reference to a render target: either the swapchain surface or a texture
/// resource the app declared (an offscreen / cacheable layer).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TargetView {
    /// The window's current swapchain texture.
    Surface,
    /// A declared texture resource — these are the offscreen passes the cache
    /// can reuse when unchanged (the basis of partial rendering).
    Texture { texture: ResourceId },
}

/// One frame's worth of GPU work: declarations + commands.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    /// Resources referenced this frame. Unchanged ones are served from cache.
    #[serde(default)]
    pub resources: Vec<ResourceDesc>,
    /// Encoder-level commands, executed in order.
    #[serde(default)]
    pub commands: Vec<EncoderCommand>,
}

impl Frame {
    pub fn parse(json: &str) -> Result<Frame, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// A top-level command recorded on the `CommandEncoder` (or queue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EncoderCommand {
    RenderPass(RenderPass),
    ComputePass(ComputePass),
    /// Splice a registered encoder-level [`Definition`](crate::Definition)'s
    /// commands in place. Resolved by the host's definition store *before*
    /// rendering — the renderer never sees this variant. Lets one frame
    /// reference a whole reusable scene (passes/copies) by id.
    UseDefinition { definition: String },
    /// Paint or reuse a registered [`Layer`](crate::Layer)'s snapshot. Resolved
    /// by the host's layer store *before* rendering — the renderer never sees
    /// this variant. If the layer's snapshot is stale it expands to the layer's
    /// painting passes (repainting the snapshot texture); if the snapshot is
    /// still valid it expands to *nothing* — the resident snapshot texture is
    /// reused and the VM never re-ran the layer's drawing. Either way the layer's
    /// snapshot texture is kept resident for the compositing pass to sample.
    UseLayer { layer: String },
    CopyBufferToBuffer {
        src: ResourceId,
        src_offset: u64,
        dst: ResourceId,
        dst_offset: u64,
        size: u64,
    },
    CopyBufferToTexture {
        src: ResourceId,
        dst: ResourceId,
        #[serde(default)]
        origin: Origin3d,
        size: Extent3d,
    },
    CopyTextureToBuffer {
        src: ResourceId,
        dst: ResourceId,
        #[serde(default)]
        origin: Origin3d,
        size: Extent3d,
    },
    CopyTextureToTexture {
        src: ResourceId,
        dst: ResourceId,
        size: Extent3d,
    },
    /// `queue.write_buffer` — refill part of a persistent buffer in place.
    ///
    /// The bytes come from whichever payload field is set, tried in order
    /// `data_b64`, `data_f32`, `data_u32`, `data_u16` (numeric arrays are packed
    /// little-endian at the backend). The numeric forms let a VM program stream a
    /// geometry/instance delta into a buffer it declared once — the language
    /// expresses number arrays natively — without paying to base64-encode it and
    /// without re-declaring the whole resource set each frame.
    WriteBuffer {
        buffer: ResourceId,
        #[serde(default)]
        offset: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_b64: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_f32: Option<Vec<f32>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_u32: Option<Vec<u32>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_u16: Option<Vec<u16>>,
    },
    /// `queue.write_texture` with base64 data.
    WriteTexture {
        texture: ResourceId,
        #[serde(default)]
        origin: Origin3d,
        size: Extent3d,
        data_b64: String,
    },
    ClearBuffer {
        buffer: ResourceId,
        #[serde(default)]
        offset: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
}

/// A render pass: targets, optional depth, and a nested command list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPass {
    /// Stable id makes this pass *cacheable*: if its content hash (commands +
    /// referenced-resource hashes) is unchanged and it targets a texture, the
    /// renderer reuses the cached texture instead of re-recording. Surface
    /// passes are always recorded but scissored to the dirty region.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub color_attachments: Vec<ColorAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth_stencil: Option<DepthAttachment>,
    pub commands: Vec<RenderCommand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorAttachment {
    pub view: TargetView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_target: Option<ResourceId>,
    /// `clear` clears to `clear_color`; otherwise the prior contents load.
    #[serde(default = "load_clear")]
    pub load: String,
    #[serde(default = "btrue")]
    pub store: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_color: Option<Color>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DepthAttachment {
    pub view: ResourceId,
    #[serde(default = "load_clear")]
    pub depth_load: String,
    #[serde(default = "one_f32")]
    pub depth_clear: f32,
    #[serde(default = "btrue")]
    pub depth_store: bool,
}

/// A command inside a render pass (mirrors `wgpu::RenderPass`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum RenderCommand {
    SetPipeline { pipeline: ResourceId },
    SetBindGroup {
        index: u32,
        bind_group: ResourceId,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dynamic_offsets: Vec<u32>,
    },
    SetVertexBuffer {
        slot: u32,
        buffer: ResourceId,
        #[serde(default)]
        offset: u64,
    },
    SetIndexBuffer {
        buffer: ResourceId,
        /// `uint16` | `uint32`.
        format: String,
        #[serde(default)]
        offset: u64,
    },
    Draw {
        vertex_count: u32,
        #[serde(default = "one_u32")]
        instance_count: u32,
        #[serde(default)]
        first_vertex: u32,
        #[serde(default)]
        first_instance: u32,
    },
    DrawIndexed {
        index_count: u32,
        #[serde(default = "one_u32")]
        instance_count: u32,
        #[serde(default)]
        first_index: u32,
        #[serde(default)]
        base_vertex: i32,
        #[serde(default)]
        first_instance: u32,
    },
    DrawIndirect { buffer: ResourceId, offset: u64 },
    DrawIndexedIndirect { buffer: ResourceId, offset: u64 },
    SetScissorRect { rect: Rect },
    SetViewport {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        #[serde(default)]
        min_depth: f32,
        #[serde(default = "one_f32")]
        max_depth: f32,
    },
    SetBlendConstant { color: Color },
    SetStencilReference { reference: u32 },
    /// Splice a registered render-level [`Definition`](crate::Definition)'s draw
    /// commands in place. Resolved by the host's definition store *before*
    /// rendering — the renderer never sees this variant. Lets a pass reference a
    /// reusable shape / complex drawing by id instead of re-emitting its draws.
    UseDefinition { definition: String },
}

/// A compute pass and its commands (mirrors `wgpu::ComputePass`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputePass {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub commands: Vec<ComputeCommand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum ComputeCommand {
    SetPipeline { pipeline: ResourceId },
    SetBindGroup {
        index: u32,
        bind_group: ResourceId,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dynamic_offsets: Vec<u32>,
    },
    Dispatch { x: u32, y: u32, z: u32 },
    DispatchIndirect { buffer: ResourceId, offset: u64 },
}

impl RenderPass {
    /// Resource ids this pass references (for cache invalidation: if any change,
    /// the pass's cached output is stale). Includes attachment textures.
    pub fn referenced_resources(&self) -> Vec<ResourceId> {
        let mut ids = Vec::new();
        for a in &self.color_attachments {
            if let TargetView::Texture { texture } = &a.view {
                ids.push(texture.clone());
            }
            if let Some(rt) = &a.resolve_target {
                ids.push(rt.clone());
            }
        }
        if let Some(d) = &self.depth_stencil {
            ids.push(d.view.clone());
        }
        for c in &self.commands {
            match c {
                RenderCommand::SetPipeline { pipeline } => ids.push(pipeline.clone()),
                RenderCommand::SetBindGroup { bind_group, .. } => ids.push(bind_group.clone()),
                RenderCommand::SetVertexBuffer { buffer, .. }
                | RenderCommand::SetIndexBuffer { buffer, .. }
                | RenderCommand::DrawIndirect { buffer, .. }
                | RenderCommand::DrawIndexedIndirect { buffer, .. } => ids.push(buffer.clone()),
                _ => {}
            }
        }
        ids
    }

    /// Whether this pass writes to the swapchain surface (so it must run every
    /// frame, scissored) rather than a cacheable offscreen texture.
    pub fn targets_surface(&self) -> bool {
        self.color_attachments.iter().any(|a| matches!(a.view, TargetView::Surface))
    }
}

impl ComputePass {
    /// Resource ids this pass references, for cache invalidation.
    pub fn referenced_resources(&self) -> Vec<ResourceId> {
        let mut ids = Vec::new();
        for c in &self.commands {
            match c {
                ComputeCommand::SetPipeline { pipeline } => ids.push(pipeline.clone()),
                ComputeCommand::SetBindGroup { bind_group, .. } => ids.push(bind_group.clone()),
                ComputeCommand::DispatchIndirect { buffer, .. } => ids.push(buffer.clone()),
                ComputeCommand::Dispatch { .. } => {}
            }
        }
        ids
    }
}

fn load_clear() -> String {
    "clear".into()
}
fn btrue() -> bool {
    true
}
fn one_u32() -> u32 {
    1
}
fn one_f32() -> f32 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: &str = r#"{
      "resources": [
        {"kind":"shader","id":"sh","wgsl":"// wgsl"},
        {"kind":"buffer","id":"vb","size":48,"usage":["VERTEX"]},
        {"kind":"renderPipeline","id":"pipe",
         "vertex":{"module":"sh","entry_point":"vs"},
         "fragment":{"module":"sh","entry_point":"fs","targets":[{"format":"bgra8unorm"}]}}
      ],
      "commands": [
        {"op":"renderPass","id":"main",
         "color_attachments":[{"view":{"kind":"surface"},"clear_color":{"r":0,"g":0,"b":0,"a":1}}],
         "commands":[
           {"cmd":"setPipeline","pipeline":"pipe"},
           {"cmd":"setVertexBuffer","slot":0,"buffer":"vb"},
           {"cmd":"draw","vertex_count":3}
         ]}
      ]
    }"#;

    #[test]
    fn parses_a_full_frame_tree() {
        let f = Frame::parse(FRAME).unwrap();
        assert_eq!(f.resources.len(), 3);
        assert_eq!(f.commands.len(), 1);
        match &f.commands[0] {
            EncoderCommand::RenderPass(rp) => {
                assert!(rp.targets_surface());
                let refs = rp.referenced_resources();
                assert!(refs.contains(&"pipe".to_string()));
                assert!(refs.contains(&"vb".to_string()));
            }
            _ => panic!("expected render pass"),
        }
    }

    #[test]
    fn write_buffer_accepts_numeric_payload() {
        // The numeric channel: a write carrying a float array, no base64.
        let json = r#"{"commands":[
            {"op":"writeBuffer","buffer":"inst","offset":16,"data_f32":[1.0,-1.0]}
        ]}"#;
        let f = Frame::parse(json).unwrap();
        match &f.commands[0] {
            EncoderCommand::WriteBuffer { buffer, offset, data_f32, data_b64, .. } => {
                assert_eq!(buffer, "inst");
                assert_eq!(*offset, 16);
                assert!(data_b64.is_none(), "no base64 needed");
                let bytes = crate::resource::pack_le_bytes(
                    None,
                    data_f32.as_deref(),
                    None,
                    None,
                )
                .unwrap();
                assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
                assert_eq!(&bytes[4..8], &(-1.0f32).to_le_bytes());
            }
            _ => panic!("expected writeBuffer"),
        }
    }

    #[test]
    fn compute_and_copy_commands_parse() {
        let json = r#"{
          "commands":[
            {"op":"computePass","commands":[
              {"cmd":"setPipeline","pipeline":"sim"},
              {"cmd":"dispatch","x":64,"y":1,"z":1}
            ]},
            {"op":"copyBufferToBuffer","src":"a","src_offset":0,"dst":"b","dst_offset":0,"size":256}
          ]
        }"#;
        let f = Frame::parse(json).unwrap();
        assert_eq!(f.commands.len(), 2);
    }
}
