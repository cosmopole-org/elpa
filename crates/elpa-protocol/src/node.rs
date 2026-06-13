//! The UI hierarchy tree carried by the `render` host call.
//!
//! The VM produces UI as a nested JSON tree of nodes. Each node is
//! `{ type, props, style, children, id, class, events }`. This matches the
//! Elpian widget/element model (Flutter-style widgets *and* HTML5 elements).
//! The renderer never rasterizes this directly — the drawing-management layer
//! first runs layout and lowers it into a flat [`crate::DrawList`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The root of a render request. The Elpian front-end wraps the tree as
/// `{ "html": <node> }`; this type accepts either that wrapper or a bare node.
#[derive(Debug, Clone)]
pub struct UiTree {
    pub root: UiNode,
}

impl UiTree {
    /// Parse a `render` payload. The VM's host-call boundary wraps an `askHost`
    /// argument list in a JSON array, and the Elpian front-end wraps the tree as
    /// `{ "html": node }`. This unwraps all of: a bare `node`, `{"html": node}`,
    /// `[node]`, and `[{"html": node}]`.
    pub fn parse(payload: &str) -> Result<UiTree, serde_json::Error> {
        let v: Value = serde_json::from_str(payload)?;
        let root: UiNode = serde_json::from_value(unwrap_node(v))?;
        Ok(UiTree { root })
    }
}

/// Peel the host-call array wrapper and the `{"html": ...}` front-end wrapper
/// off a render payload, yielding the bare node value.
fn unwrap_node(v: Value) -> Value {
    match v {
        // `askHost` arg list arrives as `[arg0, arg1, ...]`; the tree is arg0.
        Value::Array(mut items) if !items.is_empty() => unwrap_node(items.remove(0)),
        Value::Object(ref map) if map.contains_key("html") => {
            unwrap_node(map.get("html").cloned().unwrap_or(Value::Null))
        }
        other => other,
    }
}

/// One node of the UI tree. Unknown fields are tolerated so the format can grow
/// without breaking older renderers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiNode {
    /// Widget / element name: `"Column"`, `"Text"`, `"Button"`, `"div"`, ...
    #[serde(rename = "type", default)]
    pub kind: String,

    /// Stable identity used for retained-mode diffing and dirty tracking. If the
    /// app provides it (e.g. a `key`/`id`), the diff is precise; otherwise the
    /// differ falls back to positional keys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Space-separated class names for stylesheet matching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,

    /// Widget-specific properties (`text`, `value`, `src`, ...).
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub props: Map<String, Value>,

    /// Inline style map (camelCase CSS-like keys). Resolved against the
    /// stylesheet during layout.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub style: Map<String, Value>,

    /// Event-name → VM-function-name bindings (`{"click": "onPress"}`).
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub events: Map<String, Value>,

    /// Child nodes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<UiNode>,
}

impl UiNode {
    /// The key used by the differ to align this node with its previous version:
    /// explicit `id` when present, otherwise `None` (positional alignment).
    pub fn diff_key(&self) -> Option<&str> {
        self.id.as_deref()
    }

    /// Convenience accessor for a string prop (e.g. `text`).
    pub fn prop_str(&self, name: &str) -> Option<&str> {
        self.props.get(name).and_then(Value::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wrapped_and_bare_trees() {
        let wrapped = r#"{"html":{"type":"Column","children":[{"type":"Text","props":{"text":"hi"}}]}}"#;
        let t = UiTree::parse(wrapped).unwrap();
        assert_eq!(t.root.kind, "Column");
        assert_eq!(t.root.children.len(), 1);
        assert_eq!(t.root.children[0].prop_str("text"), Some("hi"));

        let bare = r#"{"type":"Button","events":{"click":"onPress"}}"#;
        let t2 = UiTree::parse(bare).unwrap();
        assert_eq!(t2.root.kind, "Button");
        assert_eq!(t2.root.events.get("click").unwrap(), "onPress");
    }
}
