// Elpa Flutter — demo app (step 2: the rendering layer).
//
// Builds a render tree by hand and mounts it under the RenderView, proving the
// Flutter box layout protocol end to end: constraints flow down, sizes flow up,
// the parent positions each child, and the tree paints through dart:ui. Later
// steps inflate this tree from a widget tree via `runApp`.

// A fixed-size coloured box.
function demoBox(color, w, h) {
    let cb = new RenderConstrainedBox(constraintsTightFor(w, h));
    cb.setChild(new RenderDecoratedBox({ color: color, borderRadius: 12.0 }, "background"));
    return cb;
}

let title = new RenderParagraph("RENDERING LAYER", { fontSize: 22.0, color: Colors.white, textAlign: "center" });
let body = new RenderParagraph("Constraints flow down, sizes flow up.", { fontSize: 13.0, color: withOpacity(Colors.white, 0.92), textAlign: "center" });
let gap = new RenderConstrainedBox(constraintsTightFor(-1.0, 14.0));

// A row of two flex children (Expanded), proving the flex algorithm.
let a = new RenderDecoratedBox({ color: withOpacity(Colors.white, 0.25), borderRadius: 8.0 }, "background");
let b = new RenderDecoratedBox({ color: withOpacity(Colors.white, 0.45), borderRadius: 8.0 }, "background");
let aH = new RenderConstrainedBox(constraintsTightFor(-1.0, 36.0)); aH.setChild(a);
let bH = new RenderConstrainedBox(constraintsTightFor(-1.0, 36.0)); bH.setChild(b);
let row = new RenderFlex("horizontal", "start", "stretch", "max");
row.setChildren([aH, bH]);
aH.parentData.flex = 2.0; bH.parentData.flex = 1.0;

let gap2 = new RenderConstrainedBox(constraintsTightFor(-1.0, 14.0));
let col = new RenderFlex("vertical", "center", "stretch", "min");
col.setChildren([title, gap, body, gap2, row]);

let pad = new RenderPadding(edgeAll(22.0)); pad.setChild(col);
let card = new RenderDecoratedBox({
    gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), [Colors.deepPurple, Colors.indigo], 0),
    borderRadius: 22.0,
    boxShadow: [{ color: withOpacity(Colors.black, 0.32), blur: 18.0, dy: 8.0 }],
}, "background");
card.setChild(pad);

let sized = new RenderConstrainedBox(constraintsTightFor(340.0, -1.0)); sized.setChild(card);
let center = new RenderPositionedBox(Alignments.center, -1.0, -1.0); center.setChild(sized);

runRenderObject(center);
