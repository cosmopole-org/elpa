//! **Reusable drawing definitions** — the abstraction layer that lets the VM
//! name a batch of GPU work once and then reference it by id, instead of
//! re-emitting its full command tree on every `gpu.submit`.
//!
//! A [`Definition`] is a *fragment* of a [`Frame`](crate::Frame): the resources
//! it needs plus a body of commands. There are two body flavors so a definition
//! can live at either level of the command tree:
//!
//! * [`DefinitionBody::Render`] — a batch of [`RenderCommand`]s (set pipeline,
//!   bind a vertex/index buffer, draw …). Spliced into a render pass wherever a
//!   [`RenderCommand::UseDefinition`] references it. This is how a "shape" or a
//!   complex 2D/3D drawing is packaged: define the draw calls once, then draw it
//!   many times across frames by id.
//! * [`DefinitionBody::Encoder`] — a batch of [`EncoderCommand`]s (whole render
//!   or compute passes, copies, queue writes). Spliced at the encoder level
//!   wherever an [`EncoderCommand::UseDefinition`] references it. This packages a
//!   self-contained scene — e.g. a 3D pass into an offscreen texture *and* a 2D
//!   overlay pass — as a single named unit.
//!
//! Definitions may reference other definitions (a `UseDefinition` inside a
//! definition's body), so a complex drawing can be composed from simpler ones in
//! a hierarchy. The host keeps registered definitions in a store and *expands*
//! each submitted frame against it before rendering, so the wire payload from
//! the VM stays tiny no matter how complex the realized frame is. 2D and 3D are
//! not distinct here — they are the same commands with different pipelines and
//! shaders, and a single definition can mix both.

use serde::{Deserialize, Serialize};

use crate::command::{EncoderCommand, RenderCommand};
use crate::resource::ResourceDesc;

/// A registered, reusable batch of GPU work, addressable by [`Definition::id`].
///
/// JSON is flat: the body's `level`/`commands` fields sit alongside `id` and
/// `resources`, e.g.
/// ```json
/// {"id":"unitCube","resources":[…],"level":"render",
///  "commands":[{"cmd":"setPipeline","pipeline":"lit3d"}, …]}
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    /// Stable name the VM references in `useDefinition` commands and the store
    /// keys on.
    pub id: String,
    /// Resources this definition depends on (shaders, pipelines, buffers …).
    /// Merged into the frame's resource set on expansion, deduplicated by id, so
    /// the renderer still creates each one once and caches it.
    #[serde(default)]
    pub resources: Vec<ResourceDesc>,
    /// The command body, tagged by `level`.
    #[serde(flatten)]
    pub body: DefinitionBody,
}

/// A definition's command body: either encoder-level or render-level commands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "level", rename_all = "camelCase")]
pub enum DefinitionBody {
    /// Encoder-level commands (passes, copies, writes). Used via
    /// [`EncoderCommand::UseDefinition`].
    Encoder { commands: Vec<EncoderCommand> },
    /// Render-pass-level commands (draws). Used via
    /// [`RenderCommand::UseDefinition`].
    Render { commands: Vec<RenderCommand> },
}

impl Definition {
    pub fn parse(json: &str) -> Result<Definition, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Definition ids referenced by this definition's body (its direct children
    /// in the composition hierarchy), used for cycle detection during expansion.
    pub fn referenced_definitions(&self) -> Vec<&str> {
        match &self.body {
            DefinitionBody::Encoder { commands } => commands
                .iter()
                .filter_map(|c| match c {
                    EncoderCommand::UseDefinition { definition } => Some(definition.as_str()),
                    EncoderCommand::RenderPass(rp) => {
                        // A nested render pass may itself use render-level defs;
                        // those are surfaced when the pass is expanded, not here.
                        let _ = rp;
                        None
                    }
                    _ => None,
                })
                .collect(),
            DefinitionBody::Render { commands } => commands
                .iter()
                .filter_map(|c| match c {
                    RenderCommand::UseDefinition { definition } => Some(definition.as_str()),
                    _ => None,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_definition_roundtrips() {
        let json = r#"{
          "id":"unitQuad",
          "resources":[{"kind":"buffer","id":"quadVB","size":48,"usage":["VERTEX"]}],
          "level":"render",
          "commands":[
            {"cmd":"setVertexBuffer","slot":0,"buffer":"quadVB"},
            {"cmd":"draw","vertex_count":6}
          ]
        }"#;
        let d = Definition::parse(json).unwrap();
        assert_eq!(d.id, "unitQuad");
        assert_eq!(d.resources.len(), 1);
        match &d.body {
            DefinitionBody::Render { commands } => assert_eq!(commands.len(), 2),
            _ => panic!("expected render body"),
        }
        let back = serde_json::to_string(&d).unwrap();
        assert_eq!(Definition::parse(&back).unwrap(), d);
    }

    #[test]
    fn encoder_definition_reports_referenced_children() {
        let json = r#"{
          "id":"scene",
          "level":"encoder",
          "commands":[
            {"op":"useDefinition","definition":"shadowPass"},
            {"op":"useDefinition","definition":"mainPass"}
          ]
        }"#;
        let d = Definition::parse(json).unwrap();
        assert_eq!(d.referenced_definitions(), vec!["shadowPass", "mainPass"]);
    }
}
