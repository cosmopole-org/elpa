//! End-to-end proof that the ported Elpian VM drives the Elpa runtime: compile
//! an AST that calls `render` with a UI tree, pump the host-call loop, and
//! confirm the runtime surfaces a parsed `UiTree` to the host.

use elpa_runtime::Runtime;
use serde_json::json;

/// An Elpian AST `{type:"program", body:[...]}` whose top-level statement is a
/// `host_call` to `render` carrying a small `{html: <UiNode>}` payload — exactly
/// what `render(<jsx>)` lowers to in the front-end.
fn render_program() -> String {
    json!({
      "type": "program",
      "body": [
        {
          "type": "host_call",
          "data": {
            "name": "render",
            "args": [
              { "type": "object", "data": { "value": {
                "html": { "type": "object", "data": { "value": {
                  "type":     { "type": "string", "data": { "value": "Column" } },
                  "children": { "type": "array",  "data": { "value": [
                    { "type": "object", "data": { "value": {
                      "type":  { "type": "string", "data": { "value": "Text" } },
                      "props": { "type": "object", "data": { "value": {
                        "text": { "type": "string", "data": { "value": "Hello Elpa" } }
                      }}}
                    }}}
                  ]}}
                }}}
              }}}
            ]
          }
        }
      ]
    })
    .to_string()
}

#[test]
fn vm_render_call_surfaces_a_ui_tree() {
    let mut rt = Runtime::from_ast("e2e-vm", &render_program())
        .expect("AST should compile and register a VM");

    let mut rendered = Vec::new();
    rt.run(|tree| {
        rendered.push(tree.root.clone());
    });

    assert_eq!(rendered.len(), 1, "exactly one render call expected");
    let root = &rendered[0];
    assert_eq!(root.kind, "Column");
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].kind, "Text");
    assert_eq!(root.children[0].prop_str("text"), Some("Hello Elpa"));

    // The runtime retains the last tree for hit-testing / diffing.
    assert!(rt.last_tree.is_some());
}
