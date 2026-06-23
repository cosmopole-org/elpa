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
        if (has(p, "scaleX")) { this.kind = "scale"; this.a = p.scaleX; this.b = 1.0; if (has(p, "scaleY")) { this.b = p.scaleY; } } }
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
class ListenerWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.handlers = p; this.behavior = "deferToChild"; if (has(p, "behavior")) { this.behavior = p.behavior; } }
    typeName() { return "Listener"; }
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
        this.left = -1.0; this.top = -1.0; this.right = -1.0; this.bottom = -1.0; this.w = -1.0; this.h = -1.0;
        if (has(p, "left")) { this.left = p.left; } if (has(p, "top")) { this.top = p.top; }
        if (has(p, "right")) { this.right = p.right; } if (has(p, "bottom")) { this.bottom = p.bottom; }
        if (has(p, "width")) { this.w = p.width; } if (has(p, "height")) { this.h = p.height; } }
    typeName() { return "Positioned"; }
    applyParentData(ro) {
        let pd = ro.parentData;
        pd.left = this.left; pd.top = this.top; pd.right = this.right; pd.bottom = this.bottom; pd.width = this.w; pd.height = this.h;
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

// ------------------------------------------------------- public constructors --
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
function Text(data, style) { return new TextWidget(data, style); }
function Column(p) { let q = p; if (isNull(p)) { q = {}; } q.direction = "vertical"; return new FlexWidget(q); }
function Row(p) { let q = p; if (isNull(p)) { q = {}; } q.direction = "horizontal"; return new FlexWidget(q); }
function Flex(p) { return new FlexWidget(p); }
function Expanded(p) { return new ExpandedWidget(p); }
function Flexible(p) { let q = p; if (isNull(p)) { q = {}; } q.fit = "loose"; return new ExpandedWidget(q); }
function Stack(p) { return new StackWidget(p); }
function Positioned(p) { return new PositionedWidget(p); }
function SafeArea(p) { return new PaddingWidget({ padding: edgeAll(0.0), child: p.child }); }
