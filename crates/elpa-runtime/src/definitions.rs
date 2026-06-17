//! **Definition store + frame expansion** — the host side of Elpa's reusable
//! drawing abstraction.
//!
//! The VM registers [`Definition`]s (via the `gpu.define` host call) into a
//! [`DefinitionStore`]. Thereafter a submitted [`Frame`] can reference any of
//! them by id with `useDefinition` commands instead of carrying their full
//! command trees. [`DefinitionStore::expand`] resolves those references into a
//! flat, self-contained `Frame` the renderer can consume directly — splicing in
//! each definition's commands and merging its resources (deduplicated by id).
//!
//! Definitions may reference other definitions, so a complex drawing composes
//! from simpler ones. Expansion walks that hierarchy depth-first with cycle
//! detection, so a malformed `A → B → A` chain is reported rather than looping
//! forever. Because the realized frame is rebuilt host-side, the wire payload
//! the VM sends stays tiny no matter how deep the composition.

use ahash::{AHashMap as HashMap, AHashSet as HashSet};

use elpa_protocol::{
    Definition, DefinitionBody, EncoderCommand, Frame, RenderCommand, RenderPass, ResourceDesc,
};

/// Why a frame (or a definition body) could not be fully expanded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpandError {
    /// A `useDefinition` referenced an id with no registered definition.
    Unknown(String),
    /// A definition (transitively) references itself; the chain is reported with
    /// the offending id last.
    Cycle(Vec<String>),
    /// A definition was used at the wrong level — e.g. an encoder-level
    /// definition referenced from inside a render pass, or vice versa.
    WrongLevel { id: String, expected: &'static str },
}

impl std::fmt::Display for ExpandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExpandError::Unknown(id) => write!(f, "unknown definition `{id}`"),
            ExpandError::Cycle(chain) => write!(f, "definition cycle: {}", chain.join(" -> ")),
            ExpandError::WrongLevel { id, expected } => {
                write!(f, "definition `{id}` used at wrong level (expected {expected})")
            }
        }
    }
}

impl std::error::Error for ExpandError {}

/// A registry of named [`Definition`]s. Persists across `gpu.submit` calls so a
/// definition registered once is referenceable by every later frame.
#[derive(Debug, Default, Clone)]
pub struct DefinitionStore {
    defs: HashMap<String, Definition>,
}

impl DefinitionStore {
    pub fn new() -> Self {
        Self { defs: HashMap::new() }
    }

    /// Register (or replace) a definition. Replacing under the same id lets an
    /// app hot-swap a drawing's internals while all references keep working.
    pub fn register(&mut self, def: Definition) {
        self.defs.insert(def.id.clone(), def);
    }

    /// Remove a definition. Returns whether one was present.
    pub fn unregister(&mut self, id: &str) -> bool {
        self.defs.remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<&Definition> {
        self.defs.get(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.defs.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.defs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.defs.is_empty()
    }

    /// Drop every registered definition.
    pub fn clear(&mut self) {
        self.defs.clear();
    }

    /// Resolve all `useDefinition` references in `frame` into a flat frame.
    ///
    /// The returned frame contains the frame's own resources plus those of every
    /// (transitively) referenced definition, deduplicated by id, and a command
    /// tree with every `useDefinition` replaced by the referenced commands.
    ///
    /// Takes the frame **by value** so the overwhelmingly common case — a frame
    /// that references no definitions — is a zero-copy move straight through,
    /// rather than a deep clone of every resource and command (which for a UI app
    /// re-declaring a multi-megabyte instance buffer each frame would copy that
    /// buffer on every submit). Only when a `useDefinition` is actually present
    /// is a new frame materialized.
    pub fn expand(&self, frame: Frame) -> Result<Frame, ExpandError> {
        if !frame_references_definitions(&frame) {
            return Ok(frame);
        }
        let mut out = Expander::new(self);
        let commands = out.encoder_commands(&frame.commands, &mut Vec::new())?;
        // Definition-supplied resources come **first** so dependencies are
        // created before dependents: a definition's bind-group *layout* (and
        // shaders/pipelines) must exist before a frame's bind group that
        // references it. Within each group, original order is preserved, and
        // ids are deduplicated keeping the first occurrence.
        let mut resources = Vec::with_capacity(out.resources.len() + frame.resources.len());
        let mut seen: HashSet<String> = HashSet::new();
        for r in out.resources.iter().chain(frame.resources.iter()) {
            if seen.insert(r.id().clone()) {
                resources.push(r.clone());
            }
        }
        Ok(Frame { resources, commands })
    }
}

/// Whether a frame contains any `useDefinition` reference (at the encoder level
/// or inside a render pass). When it does not, [`DefinitionStore::expand`] can
/// hand the frame straight back with no allocation.
fn frame_references_definitions(frame: &Frame) -> bool {
    frame.commands.iter().any(|cmd| match cmd {
        EncoderCommand::UseDefinition { .. } => true,
        EncoderCommand::RenderPass(rp) => rp
            .commands
            .iter()
            .any(|c| matches!(c, RenderCommand::UseDefinition { .. })),
        _ => false,
    })
}

/// Carries the resources accumulated from referenced definitions while a single
/// `expand` call walks the command tree.
struct Expander<'s> {
    store: &'s DefinitionStore,
    resources: Vec<ResourceDesc>,
    /// Definition ids whose resources have already been collected, so a shape
    /// referenced many times contributes its resources only once.
    collected: HashSet<String>,
}

impl<'s> Expander<'s> {
    fn new(store: &'s DefinitionStore) -> Self {
        Self { store, resources: Vec::new(), collected: HashSet::new() }
    }

    /// Add a definition's own resources to the accumulator (once per id).
    fn collect_resources(&mut self, def: &Definition) {
        if self.collected.insert(def.id.clone()) {
            self.resources.extend(def.resources.iter().cloned());
        }
    }

    /// Expand a list of encoder-level commands, splicing encoder definitions.
    fn encoder_commands(
        &mut self,
        cmds: &[EncoderCommand],
        stack: &mut Vec<String>,
    ) -> Result<Vec<EncoderCommand>, ExpandError> {
        let mut out = Vec::with_capacity(cmds.len());
        for cmd in cmds {
            match cmd {
                EncoderCommand::UseDefinition { definition } => {
                    let def = self.lookup(definition, stack)?;
                    let inner = match &def.body {
                        DefinitionBody::Encoder { commands } => commands,
                        DefinitionBody::Render { .. } => {
                            return Err(ExpandError::WrongLevel {
                                id: definition.clone(),
                                expected: "encoder",
                            })
                        }
                    };
                    self.collect_resources(def);
                    stack.push(definition.clone());
                    let expanded = self.encoder_commands(inner, stack)?;
                    stack.pop();
                    out.extend(expanded);
                }
                EncoderCommand::RenderPass(rp) => {
                    out.push(EncoderCommand::RenderPass(self.render_pass(rp, stack)?));
                }
                // Compute passes / copies / writes carry no definition refs.
                other => out.push(other.clone()),
            }
        }
        Ok(out)
    }

    /// Expand one render pass, splicing render definitions inside it.
    fn render_pass(
        &mut self,
        rp: &RenderPass,
        stack: &mut Vec<String>,
    ) -> Result<RenderPass, ExpandError> {
        Ok(RenderPass {
            id: rp.id.clone(),
            color_attachments: rp.color_attachments.clone(),
            depth_stencil: rp.depth_stencil.clone(),
            commands: self.render_commands(&rp.commands, stack)?,
        })
    }

    /// Expand a list of render-level commands, splicing render definitions.
    fn render_commands(
        &mut self,
        cmds: &[RenderCommand],
        stack: &mut Vec<String>,
    ) -> Result<Vec<RenderCommand>, ExpandError> {
        let mut out = Vec::with_capacity(cmds.len());
        for cmd in cmds {
            match cmd {
                RenderCommand::UseDefinition { definition } => {
                    let def = self.lookup(definition, stack)?;
                    let inner = match &def.body {
                        DefinitionBody::Render { commands } => commands,
                        DefinitionBody::Encoder { .. } => {
                            return Err(ExpandError::WrongLevel {
                                id: definition.clone(),
                                expected: "render",
                            })
                        }
                    };
                    self.collect_resources(def);
                    stack.push(definition.clone());
                    let expanded = self.render_commands(inner, stack)?;
                    stack.pop();
                    out.extend(expanded);
                }
                other => out.push(other.clone()),
            }
        }
        Ok(out)
    }

    /// Resolve a definition id, rejecting unknown ids and cycles.
    fn lookup(&self, id: &str, stack: &[String]) -> Result<&'s Definition, ExpandError> {
        if stack.iter().any(|s| s == id) {
            let mut chain = stack.to_vec();
            chain.push(id.to_string());
            return Err(ExpandError::Cycle(chain));
        }
        self.store.get(id).ok_or_else(|| ExpandError::Unknown(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::command::{ColorAttachment, TargetView};
    use elpa_protocol::resource::{BufferDesc, ShaderDesc};

    fn buf(id: &str) -> ResourceDesc {
        ResourceDesc::Buffer(BufferDesc::new(id, 16, vec!["VERTEX".into()]))
    }

    fn shader(id: &str) -> ResourceDesc {
        ResourceDesc::Shader(ShaderDesc { id: id.into(), wgsl: "//".into() })
    }

    fn render_def(id: &str, vb: &str) -> Definition {
        Definition {
            id: id.into(),
            resources: vec![buf(vb)],
            body: DefinitionBody::Render {
                commands: vec![
                    RenderCommand::SetVertexBuffer { slot: 0, buffer: vb.into(), offset: 0 },
                    RenderCommand::Draw {
                        vertex_count: 3,
                        instance_count: 1,
                        first_vertex: 0,
                        first_instance: 0,
                    },
                ],
            },
        }
    }

    fn surface_pass(commands: Vec<RenderCommand>) -> EncoderCommand {
        EncoderCommand::RenderPass(RenderPass {
            id: Some("main".into()),
            color_attachments: vec![ColorAttachment {
                view: TargetView::Surface,
                resolve_target: None,
                load: "clear".into(),
                store: true,
                clear_color: None,
            }],
            depth_stencil: None,
            commands,
        })
    }

    #[test]
    fn passthrough_when_no_references() {
        let store = DefinitionStore::new();
        let frame = Frame {
            resources: vec![shader("sh")],
            commands: vec![surface_pass(vec![RenderCommand::Draw {
                vertex_count: 3,
                instance_count: 1,
                first_vertex: 0,
                first_instance: 0,
            }])],
        };
        assert_eq!(store.expand(frame.clone()).unwrap(), frame);
    }

    #[test]
    fn render_definition_is_spliced_and_resources_merged() {
        let mut store = DefinitionStore::new();
        store.register(render_def("tri", "triVB"));

        let frame = Frame {
            resources: vec![],
            // Reference the same shape twice — it should expand twice but its
            // resource should appear only once.
            commands: vec![surface_pass(vec![
                RenderCommand::UseDefinition { definition: "tri".into() },
                RenderCommand::UseDefinition { definition: "tri".into() },
            ])],
        };

        let out = store.expand(frame).unwrap();
        assert_eq!(out.resources.len(), 1, "shape resource merged once");
        match &out.commands[0] {
            EncoderCommand::RenderPass(rp) => {
                // 2 commands per shape * 2 uses = 4, no UseDefinition left.
                assert_eq!(rp.commands.len(), 4);
                assert!(rp
                    .commands
                    .iter()
                    .all(|c| !matches!(c, RenderCommand::UseDefinition { .. })));
            }
            _ => panic!("expected render pass"),
        }
    }

    #[test]
    fn encoder_definition_composes_render_definitions() {
        let mut store = DefinitionStore::new();
        store.register(render_def("tri", "triVB"));
        // An encoder-level scene that owns a pass which uses the render def.
        store.register(Definition {
            id: "scene".into(),
            resources: vec![shader("sceneSh")],
            body: DefinitionBody::Encoder {
                commands: vec![surface_pass(vec![RenderCommand::UseDefinition {
                    definition: "tri".into(),
                }])],
            },
        });

        let frame = Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseDefinition { definition: "scene".into() }],
        };
        let out = store.expand(frame).unwrap();
        assert_eq!(out.commands.len(), 1);
        assert_eq!(out.resources.len(), 2, "scene shader + triangle buffer");
        match &out.commands[0] {
            EncoderCommand::RenderPass(rp) => assert_eq!(rp.commands.len(), 2),
            _ => panic!("expected render pass"),
        }
    }

    #[test]
    fn unknown_reference_is_reported() {
        let store = DefinitionStore::new();
        let frame = Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseDefinition { definition: "ghost".into() }],
        };
        assert_eq!(store.expand(frame), Err(ExpandError::Unknown("ghost".into())));
    }

    #[test]
    fn cycle_is_detected() {
        let mut store = DefinitionStore::new();
        store.register(Definition {
            id: "a".into(),
            resources: vec![],
            body: DefinitionBody::Encoder {
                commands: vec![EncoderCommand::UseDefinition { definition: "b".into() }],
            },
        });
        store.register(Definition {
            id: "b".into(),
            resources: vec![],
            body: DefinitionBody::Encoder {
                commands: vec![EncoderCommand::UseDefinition { definition: "a".into() }],
            },
        });
        let frame = Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseDefinition { definition: "a".into() }],
        };
        match store.expand(frame) {
            Err(ExpandError::Cycle(chain)) => {
                assert_eq!(chain, vec!["a".to_string(), "b".to_string(), "a".to_string()])
            }
            other => panic!("expected cycle, got {other:?}"),
        }
    }

    #[test]
    fn wrong_level_is_reported() {
        let mut store = DefinitionStore::new();
        store.register(render_def("tri", "triVB"));
        // Using a render-level def at the encoder level is an error.
        let frame = Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseDefinition { definition: "tri".into() }],
        };
        assert_eq!(
            store.expand(frame),
            Err(ExpandError::WrongLevel { id: "tri".into(), expected: "encoder" })
        );
    }
}
