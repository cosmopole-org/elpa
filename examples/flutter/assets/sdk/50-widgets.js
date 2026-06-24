// Elpa Flutter — the widget catalog.
//
// The everyday widgets, each either a RenderObjectWidget (creates/updates a
// render object from the rendering layer) or a StatelessWidget that composes
// other widgets — exactly as in package:flutter/widgets. The public constructor
// functions at the bottom are the app-facing API (Container({...}), Row({...}),
// Text("hi", {...})), mirroring Flutter's widget constructors.

// ---------------------------------------------------- layout render widgets ---
class SizedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.w = -1.0; this.h = -1.0; if (has(p, "width")) { this.w = p.width; } if (has(p, "height")) { this.h = p.height; } }
    typeName() { return "SizedBox"; }
    createRenderObject(context) { return new RenderConstrainedBox(constraintsTightFor(this.w, this.h)); }
    updateRenderObject(context, ro) { ro.additional = constraintsTightFor(this.w, this.h); ro.markNeedsLayout(); }
}
class ConstrainedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.constraints = p.constraints; }
    typeName() { return "ConstrainedBox"; }
    createRenderObject(context) { return new RenderConstrainedBox(this.constraints); }
    updateRenderObject(context, ro) { ro.additional = this.constraints; ro.markNeedsLayout(); }
}
class PaddingWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.padding = p.padding; }
    typeName() { return "Padding"; }
    createRenderObject(context) { return new RenderPadding(this.padding); }
    updateRenderObject(context, ro) { ro.padding = this.padding; ro.markNeedsLayout(); }
}
class AlignWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.alignment = Alignments.center; if (has(p, "alignment")) { this.alignment = p.alignment; }
        this.wf = -1.0; this.hf = -1.0; if (has(p, "widthFactor")) { this.wf = p.widthFactor; } if (has(p, "heightFactor")) { this.hf = p.heightFactor; } }
    typeName() { return "Align"; }
    createRenderObject(context) { return new RenderPositionedBox(this.alignment, this.wf, this.hf); }
    updateRenderObject(context, ro) { ro.alignment = this.alignment; ro.widthFactor = this.wf; ro.heightFactor = this.hf; ro.markNeedsLayout(); }
}
class DecoratedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.decoration = p.decoration; this.position = "background"; if (has(p, "position")) { this.position = p.position; } }
    typeName() { return "DecoratedBox"; }
    createRenderObject(context) { return new RenderDecoratedBox(this.decoration, this.position); }
    updateRenderObject(context, ro) { ro.decoration = this.decoration; ro.position = this.position; ro.markNeedsPaint(); }
}
class OpacityWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.opacity = p.opacity; }
    typeName() { return "Opacity"; }
    createRenderObject(context) { return new RenderOpacity(this.opacity); }
    updateRenderObject(context, ro) { ro.opacity = this.opacity; ro.markNeedsPaint(); }
}
class TransformWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.kind = "rotate"; this.a = 0.0; this.b = 0.0;
        if (has(p, "angle")) { this.kind = "rotate"; this.a = p.angle; }
        if (has(p, "scale")) { this.kind = "scale"; this.a = p.scale; this.b = p.scale; }
        if (has(p, "scaleX")) { this.kind = "scale"; this.a = p.scaleX; this.b = 1.0; if (has(p, "scaleY")) { this.b = p.scaleY; } }
        if (has(p, "offset")) { this.kind = "translate"; this.a = p.offset.dx; this.b = p.offset.dy; } }
    typeName() { return "Transform"; }
    createRenderObject(context) { return new RenderTransform(this.kind, this.a, this.b); }
    updateRenderObject(context, ro) { ro.kind = this.kind; ro.a = this.a; ro.b = this.b; ro.markNeedsPaint(); }
}
class ClipRRectWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.r = 0.0; if (has(p, "borderRadius")) { this.r = p.borderRadius; } }
    typeName() { return "ClipRRect"; }
    createRenderObject(context) { return new RenderClipRRect(this.r); }
    updateRenderObject(context, ro) { ro.radius = this.r; }
}
class ClipRectWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); }
    typeName() { return "ClipRect"; }
    createRenderObject(context) { return new RenderClipRect(); }
    updateRenderObject(context, ro) { return 0; }
}
class ClipOvalWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); }
    typeName() { return "ClipOval"; }
    createRenderObject(context) { return new RenderClipOval(); }
    updateRenderObject(context, ro) { return 0; }
}
// IgnorePointer / AbsorbPointer: drop hit-testing of the subtree (Flutter's
// RenderIgnorePointer). A closed drawer's full-screen scrim uses this so it does
// not swallow taps meant for the UI beneath it.
class RenderIgnorePointer extends RenderProxyBox {
    constructor(ignoring) { super(); this.ignoring = ignoring; }
    hitTest(result, pos) {
        if (this.ignoring > 0.5) { return false; }
        if (this.size.contains(pos)) {
            let hit = false;
            if (this.hitTestChildren(result, pos)) { hit = true; }
            if (this.hitTestSelf(pos)) { hit = true; }
            if (hit) { result.add(new HitTestEntry(this, pos)); return true; }
        }
        return false;
    }
}
class IgnorePointerWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.ignoring = 1.0; if (has(p, "ignoring")) { if (!p.ignoring) { this.ignoring = 0.0; } } }
    typeName() { return "IgnorePointer"; }
    createRenderObject(context) { return new RenderIgnorePointer(this.ignoring); }
    updateRenderObject(context, ro) { ro.ignoring = this.ignoring; }
}
class RenderAbsorbPointer extends RenderProxyBox {
    constructor(absorbing) { super(); this.absorbing = absorbing; }
    hitTest(result, pos) {
        if (this.absorbing > 0.5) { if (this.size.contains(pos)) { result.add(new HitTestEntry(this, pos)); return true; } return false; }
        if (this.size.contains(pos)) {
            let hit = false;
            if (this.hitTestChildren(result, pos)) { hit = true; }
            if (this.hitTestSelf(pos)) { hit = true; }
            if (hit) { result.add(new HitTestEntry(this, pos)); return true; }
        }
        return false;
    }
}
class AbsorbPointerWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.absorbing = 1.0; if (has(p, "absorbing")) { if (!p.absorbing) { this.absorbing = 0.0; } } }
    typeName() { return "AbsorbPointer"; }
    createRenderObject(context) { return new RenderAbsorbPointer(this.absorbing); }
    updateRenderObject(context, ro) { ro.absorbing = this.absorbing; }
}
class ListenerWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.handlers = p; this.behavior = "deferToChild"; if (has(p, "behavior")) { this.behavior = p.behavior; } }
    typeName() { return "Listener"; }
    createRenderObject(context) { return new RenderPointerListener(this.handlers, this.behavior); }
    updateRenderObject(context, ro) { ro.handlers = this.handlers; ro.behavior = this.behavior; }
}
// GestureDetector: a Listener whose `onTap` is fired by the binding's tap
// recognizer (press + release over the same detector). Defaults to opaque hit
// behaviour so the whole area is tappable.
class GestureDetectorWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.handlers = p; this.behavior = "opaque"; if (has(p, "behavior")) { this.behavior = p.behavior; } }
    typeName() { return "GestureDetector"; }
    createRenderObject(context) { return new RenderPointerListener(this.handlers, this.behavior); }
    updateRenderObject(context, ro) { ro.handlers = this.handlers; ro.behavior = this.behavior; }
}

// ------------------------------------------------------------ Text widget -----
class TextWidget extends LeafRenderObjectWidget {
    constructor(data, style) { super({}); this.data = data; this.style = style; if (isNull(style)) { this.style = {}; } if (style == 0) { this.style = {}; } }
    typeName() { return "Text"; }
    createRenderObject(context) { return new RenderParagraph(this.data, this.style); }
    updateRenderObject(context, ro) { ro.text = this.data; ro.style = this.style; ro.markNeedsLayout(); }
}

// --------------------------------------------------------------- Flex / Stack -
class FlexWidget extends MultiChildRenderObjectWidget {
    constructor(p) { super(p);
        this.direction = "vertical"; if (has(p, "direction")) { this.direction = p.direction; }
        this.mainAxisAlignment = "start"; if (has(p, "mainAxisAlignment")) { this.mainAxisAlignment = p.mainAxisAlignment; }
        this.crossAxisAlignment = "center"; if (has(p, "crossAxisAlignment")) { this.crossAxisAlignment = p.crossAxisAlignment; }
        this.mainAxisSize = "max"; if (has(p, "mainAxisSize")) { this.mainAxisSize = p.mainAxisSize; } }
    typeName() { return concat("Flex.", this.direction); }
    createRenderObject(context) { return new RenderFlex(this.direction, this.mainAxisAlignment, this.crossAxisAlignment, this.mainAxisSize); }
    updateRenderObject(context, ro) {
        ro.direction = this.direction; ro.mainAxisAlignment = this.mainAxisAlignment;
        ro.crossAxisAlignment = this.crossAxisAlignment; ro.mainAxisSize = this.mainAxisSize; ro.markNeedsLayout();
    }
}
class StackWidget extends MultiChildRenderObjectWidget {
    constructor(p) { super(p); this.alignment = Alignments.topLeft; if (has(p, "alignment")) { this.alignment = p.alignment; }
        this.fit = "loose"; if (has(p, "fit")) { this.fit = p.fit; } }
    typeName() { return "Stack"; }
    createRenderObject(context) { return new RenderStack(this.alignment, this.fit); }
    updateRenderObject(context, ro) { ro.alignment = this.alignment; ro.fit = this.fit; ro.markNeedsLayout(); }
}

// ---- ParentData widgets: Expanded / Flexible / Positioned ----
class ExpandedWidget extends ParentDataWidget {
    constructor(p) { super(p); this.flex = 1.0; if (has(p, "flex")) { this.flex = p.flex; } this.fit = "tight"; if (has(p, "fit")) { this.fit = p.fit; } }
    typeName() { return "Expanded"; }
    applyParentData(ro) {
        if (ro.parentData.flex != this.flex) { ro.parentData.flex = this.flex; ro.parentData.fit = this.fit; if (isRenderObj(ro.parent)) { ro.parent.markNeedsLayout(); } }
        else { ro.parentData.fit = this.fit; }
    }
}
class PositionedWidget extends ParentDataWidget {
    constructor(p) { super(p);
        this.left = 0.0; this.top = 0.0; this.right = 0.0; this.bottom = 0.0; this.w = 0.0; this.h = 0.0;
        this.hl = 0.0; this.ht = 0.0; this.hr = 0.0; this.hb = 0.0; this.hw = 0.0; this.hh = 0.0;
        if (has(p, "left")) { this.left = p.left; this.hl = 1.0; } if (has(p, "top")) { this.top = p.top; this.ht = 1.0; }
        if (has(p, "right")) { this.right = p.right; this.hr = 1.0; } if (has(p, "bottom")) { this.bottom = p.bottom; this.hb = 1.0; }
        if (has(p, "width")) { this.w = p.width; this.hw = 1.0; } if (has(p, "height")) { this.h = p.height; this.hh = 1.0; } }
    typeName() { return "Positioned"; }
    applyParentData(ro) {
        let pd = ro.parentData;
        pd.left = this.left; pd.top = this.top; pd.right = this.right; pd.bottom = this.bottom; pd.width = this.w; pd.height = this.h;
        pd.hl = this.hl; pd.ht = this.ht; pd.hr = this.hr; pd.hb = this.hb; pd.hw = this.hw; pd.hh = this.hh;
        if (isRenderObj(ro.parent)) { ro.parent.markNeedsLayout(); }
    }
}

// ------------------------------------------------ StatelessWidget: Container --
// Container composes Align / Padding / DecoratedBox / ConstrainedBox / Transform,
// exactly like Flutter's Container.build.
class ContainerWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Container"; }
    build(context) {
        let p = this.p; let current = 0; if (has(p, "child")) { current = p.child; }
        if (has(p, "alignment")) { current = new AlignWidget({ alignment: p.alignment, child: current }); }
        if (has(p, "padding")) { current = new PaddingWidget({ padding: p.padding, child: current }); }
        let deco = 0;
        if (has(p, "decoration")) { deco = p.decoration; }
        else { if (has(p, "color")) { deco = { color: p.color }; if (has(p, "borderRadius")) { deco.borderRadius = p.borderRadius; } } }
        if (deco != 0) { current = new DecoratedBoxWidget({ decoration: deco, child: current }); }
        let w = -1.0; let h = -1.0; if (has(p, "width")) { w = p.width; } if (has(p, "height")) { h = p.height; }
        if (w >= 0.0) { current = new SizedBoxWidget({ width: w, height: h, child: current }); }
        else { if (h >= 0.0) { current = new SizedBoxWidget({ width: w, height: h, child: current }); } }
        if (has(p, "constraints")) { current = new ConstrainedBoxWidget({ constraints: p.constraints, child: current }); }
        if (has(p, "margin")) { current = new PaddingWidget({ padding: p.margin, child: current }); }
        return current;
    }
}

// ================================================== extended layout catalog ===
// More of the everyday layout widgets, each a render object (defined inline, as
// the Material catalog does with RenderIcon) plus its widget wrapper.

// ---- AspectRatio ----
class RenderAspectRatio extends RenderProxyBox {
    constructor(aspect) { super(); this.aspect = aspect; }
    _applySize(c) {
        if (c.isTight()) { return c.smallest(); }
        let w = c.maxW;
        if (!c.hasBoundedWidth()) { w = c.maxH * this.aspect; }
        let h = w / this.aspect;
        if (w > c.maxW) { w = c.maxW; h = w / this.aspect; }
        if (h > c.maxH) { h = c.maxH; w = h * this.aspect; }
        return new Size(c.constrainWidth(w), c.constrainHeight(h));
    }
    performLayout() {
        this.size = this._applySize(this._constraints);
        if (this.child != 0) { this.child.layout(constraintsTight(this.size), 1.0); }
    }
}
class AspectRatioWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.aspect = p.aspectRatio; }
    typeName() { return "AspectRatio"; }
    createRenderObject(context) { return new RenderAspectRatio(this.aspect); }
    updateRenderObject(context, ro) { ro.aspect = this.aspect; ro.markNeedsLayout(); }
}

// ---- FractionallySizedBox ----
class RenderFractionallySizedBox extends RenderBox {
    constructor(wf, hf, alignment) { super(); this.wf = wf; this.hf = hf; this.alignment = alignment; this.child = 0; }
    setChild(c) { if (sameRef(this.child, c)) { return 0; } if (this.child != 0) { this.dropChild(this.child); } this.child = c; if (c != 0) { this.adoptChild(c); } }
    visitChildren(fn) { if (this.child != 0) { fn(this.child); } }
    redepthChildren() { if (this.child != 0) { this.redepthChild(this.child); } }
    performLayout() {
        let c = this._constraints; this.size = c.constrain(c.biggest());
        if (this.child == 0) { return 0; }
        let minW = 0.0; let maxW = INFTY; let minH = 0.0; let maxH = INFTY;
        if (this.wf >= 0.0) { let w = this.size.width * this.wf; minW = w; maxW = w; }
        if (this.hf >= 0.0) { let h = this.size.height * this.hf; minH = h; maxH = h; }
        this.child.layout(new BoxConstraints(minW, maxW, minH, maxH), 1.0);
        this.child.parentData.offset = this.alignment.alongOffset(this.size.width - this.child.size.width, this.size.height - this.child.size.height);
    }
    paint(context, off) { if (this.child != 0) { let o = this.child.parentData.offset; context.paintChild(this.child, new Offset(off.dx + o.dx, off.dy + o.dy)); } }
    hitTestChildren(result, pos) { if (this.child != 0) { let o = this.child.parentData.offset; return this.child.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy)); } return false; }
}
class FractionallySizedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.wf = -1.0; this.hf = -1.0; this.alignment = Alignments.center;
        if (has(p, "widthFactor")) { this.wf = p.widthFactor; } if (has(p, "heightFactor")) { this.hf = p.heightFactor; }
        if (has(p, "alignment")) { this.alignment = p.alignment; } }
    typeName() { return "FractionallySizedBox"; }
    createRenderObject(context) { return new RenderFractionallySizedBox(this.wf, this.hf, this.alignment); }
    updateRenderObject(context, ro) { ro.wf = this.wf; ro.hf = this.hf; ro.alignment = this.alignment; ro.markNeedsLayout(); }
}

// ---- LimitedBox (caps size only when the incoming axis is unbounded) ----
class RenderLimitedBox extends RenderProxyBox {
    constructor(maxW, maxH) { super(); this.maxW = maxW; this.maxH = maxH; }
    performLayout() {
        let c = this._constraints;
        let mw = c.maxW; if (!c.hasBoundedWidth()) { mw = this.maxW; }
        let mh = c.maxH; if (!c.hasBoundedHeight()) { mh = this.maxH; }
        if (this.child != 0) { this.child.layout(new BoxConstraints(c.minW, mw, c.minH, mh), 1.0); this.size = c.constrain(this.child.size); }
        else { this.size = c.constrain(SIZE_ZERO); }
    }
}
class LimitedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.maxW = INFTY; this.maxH = INFTY; if (has(p, "maxWidth")) { this.maxW = p.maxWidth; } if (has(p, "maxHeight")) { this.maxH = p.maxHeight; } }
    typeName() { return "LimitedBox"; }
    createRenderObject(context) { return new RenderLimitedBox(this.maxW, this.maxH); }
    updateRenderObject(context, ro) { ro.maxW = this.maxW; ro.maxH = this.maxH; ro.markNeedsLayout(); }
}

// ---- FittedBox (scales child to fit the box; contain / cover / fill) ----
class RenderFittedBox extends RenderProxyBox {
    constructor(fit, alignment) { super(); this.fit = fit; this.alignment = alignment; this._s = 1.0; this._dx = 0.0; this._dy = 0.0; }
    performLayout() {
        let c = this._constraints;
        if (this.child == 0) { this.size = c.smallest(); return 0; }
        this.child.layout(new BoxConstraints(0.0, INFTY, 0.0, INFTY), 1.0);
        this.size = c.constrain(this.child.size);
        let cw = this.child.size.width; let ch = this.child.size.height;
        let sx = 1.0; let sy = 1.0; if (cw > 0.0) { sx = this.size.width / cw; } if (ch > 0.0) { sy = this.size.height / ch; }
        let s = min(sx, sy); if (this.fit == "cover") { s = max(sx, sy); }
        this._s = s; this._dx = (this.size.width - cw * s) / 2.0; this._dy = (this.size.height - ch * s) / 2.0;
    }
    paint(context, off) {
        if (this.child == 0) { return 0; }
        let canvas = context.canvas; canvas.save();
        canvas.translate(off.dx + this._dx, off.dy + this._dy); canvas.scale(this._s, this._s);
        context.paintChild(this.child, OFFSET_ZERO);
        canvas.restore();
    }
}
class FittedBoxWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.fit = "contain"; this.alignment = Alignments.center; if (has(p, "fit")) { this.fit = p.fit; } if (has(p, "alignment")) { this.alignment = p.alignment; } }
    typeName() { return "FittedBox"; }
    createRenderObject(context) { return new RenderFittedBox(this.fit, this.alignment); }
    updateRenderObject(context, ro) { ro.fit = this.fit; ro.alignment = this.alignment; ro.markNeedsLayout(); }
}

// ---- Wrap (run-based flow layout for chips/tags) ----
class RenderWrap extends RenderBox {
    constructor(spacing, runSpacing, alignment) { super(); this.spacing = spacing; this.runSpacing = runSpacing; this.alignment = alignment; this.children = []; }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new BoxParentData(); } }
    syncChildren(list) { syncContainerChildren(this, list); }
    visitChildren(fn) { for (let i = 0; i < len(this.children); i++) { fn(this.children[i]); } }
    redepthChildren() { for (let i = 0; i < len(this.children); i++) { this.redepthChild(this.children[i]); } }
    performLayout() {
        let c = this._constraints; let maxW = c.maxW; if (maxW >= INFTY) { maxW = 1.0e9; }
        let x = 0.0; let y = 0.0; let runH = 0.0; let lineW = 0.0; let n = len(this.children);
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; ch.layout(c.loosen(), 1.0);
            let w = ch.size.width; let h = ch.size.height;
            if (x > 0.0) { if (x + w > maxW) { x = 0.0; y = y + runH + this.runSpacing; runH = 0.0; } }
            ch.parentData.offset = new Offset(x, y);
            x = x + w + this.spacing; if (x - this.spacing > lineW) { lineW = x - this.spacing; }
            if (h > runH) { runH = h; }
        }
        this.size = c.constrain(new Size(lineW, y + runH));
    }
    paint(context, off) { for (let i = 0; i < len(this.children); i++) { let ch = this.children[i]; let o = ch.parentData.offset; context.paintChild(ch, new Offset(off.dx + o.dx, off.dy + o.dy)); } }
    hitTestChildren(result, pos) {
        for (let i = len(this.children) - 1; i >= 0; i--) { let ch = this.children[i]; let o = ch.parentData.offset; if (ch.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy))) { return true; } }
        return false;
    }
}
class WrapWidget extends MultiChildRenderObjectWidget {
    constructor(p) { super(p); this.spacing = 0.0; this.runSpacing = 0.0; this.alignment = "start";
        if (has(p, "spacing")) { this.spacing = p.spacing; } if (has(p, "runSpacing")) { this.runSpacing = p.runSpacing; } if (has(p, "alignment")) { this.alignment = p.alignment; } }
    typeName() { return "Wrap"; }
    createRenderObject(context) { return new RenderWrap(this.spacing, this.runSpacing, this.alignment); }
    updateRenderObject(context, ro) { ro.spacing = this.spacing; ro.runSpacing = this.runSpacing; ro.alignment = this.alignment; ro.markNeedsLayout(); }
}

// ------------------------------------------------------- public constructors --
function AspectRatio(p) { return new AspectRatioWidget(p); }
function FractionallySizedBox(p) { return new FractionallySizedBoxWidget(p); }
function LimitedBox(p) { return new LimitedBoxWidget(p); }
function FittedBox(p) { return new FittedBoxWidget(p); }
function Wrap(p) { return new WrapWidget(p); }
function ClipRect(p) { return new ClipRectWidget(p); }
function ClipOval(p) { return new ClipOvalWidget(p); }
function IgnorePointer(p) { return new IgnorePointerWidget(p); }
function AbsorbPointer(p) { return new AbsorbPointerWidget(p); }
function Spacer(p) { let f = 1.0; if (!isNull(p)) { if (has(p, "flex")) { f = p.flex; } } return new ExpandedWidget({ flex: f, child: new SizedBoxWidget({}) }); }
function Divider(p) {
    let h = 16.0; let th = 1.0; let col = colorRGBO(0, 0, 0, 0.12); let indent = 0.0;
    if (!isNull(p)) { if (has(p, "height")) { h = p.height; } if (has(p, "thickness")) { th = p.thickness; } if (has(p, "color")) { col = p.color; } if (has(p, "indent")) { indent = p.indent; } }
    return new SizedBoxWidget({ height: h, child: new AlignWidget({ alignment: Alignments.center,
        child: new PaddingWidget({ padding: edgeOnly(indent, 0.0, indent, 0.0),
            child: new SizedBoxWidget({ height: th, child: new DecoratedBoxWidget({ decoration: { color: col } }) }) }) }) });
}
function VerticalDivider(p) {
    let w = 16.0; let th = 1.0; let col = colorRGBO(0, 0, 0, 0.12);
    if (!isNull(p)) { if (has(p, "width")) { w = p.width; } if (has(p, "thickness")) { th = p.thickness; } if (has(p, "color")) { col = p.color; } }
    return new SizedBoxWidget({ width: w, child: new AlignWidget({ alignment: Alignments.center,
        child: new SizedBoxWidget({ width: th, child: new DecoratedBoxWidget({ decoration: { color: col } }) }) }) });
}
function SizedBox(p) { return new SizedBoxWidget(p); }
function ConstrainedBox(p) { return new ConstrainedBoxWidget(p); }
function Container(p) { return new ContainerWidget(p); }
function Padding(p) { return new PaddingWidget(p); }
function Align(p) { return new AlignWidget(p); }
function Center(p) { let q = p; if (isNull(p)) { q = {}; } q.alignment = Alignments.center; return new AlignWidget(q); }
function DecoratedBox(p) { return new DecoratedBoxWidget(p); }
function ColoredBox(p) { return new DecoratedBoxWidget({ decoration: { color: p.color }, child: p.child }); }
function Opacity(p) { return new OpacityWidget(p); }
function Transform(p) { return new TransformWidget(p); }
function ClipRRect(p) { return new ClipRRectWidget(p); }
function Listener(p) { return new ListenerWidget(p); }
function GestureDetector(p) { return new GestureDetectorWidget(p); }
function Text(data, style) { return new TextWidget(data, style); }
function Column(p) { let q = p; if (isNull(p)) { q = {}; } q.direction = "vertical"; return new FlexWidget(q); }
function Row(p) { let q = p; if (isNull(p)) { q = {}; } q.direction = "horizontal"; return new FlexWidget(q); }
function Flex(p) { return new FlexWidget(p); }
function Expanded(p) { return new ExpandedWidget(p); }
function Flexible(p) { let q = p; if (isNull(p)) { q = {}; } q.fit = "loose"; return new ExpandedWidget(q); }
function Stack(p) { return new StackWidget(p); }
function Positioned(p) { return new PositionedWidget(p); }
function SafeArea(p) { return new PaddingWidget({ padding: edgeAll(0.0), child: p.child }); }
