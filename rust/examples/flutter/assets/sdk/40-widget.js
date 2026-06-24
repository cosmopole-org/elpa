// Elpa Flutter — the widgets layer (package:flutter/widgets analog).
//
// Widgets are immutable configuration; Elements are their mutable instantiation
// and hold the tree's identity. Inflating a widget creates an element; rebuilding
// reconciles the new widget against the old element (Widget.canUpdate: same
// runtime type + key), reusing the element — and its render object — in place.
// `StatefulWidget`/`State.setState` marks an element dirty; the `BuildOwner`
// rebuilds the dirty elements in depth order each frame (buildScope). This is the
// real Flutter element machinery, faithful to the framework.

// ---- array helpers (no splice in the VM subset) ----
function arrInsert(a, idx, v) { return concat(concat(slice(a, 0, idx), [v]), slice(a, idx, len(a))); }
function arrContains(a, v) { for (let i = 0; i < len(a); i++) { if (sameRef(a[i], v)) { return true; } } return false; }
function arrRemoveVal(a, v) { let out = []; for (let i = 0; i < len(a); i++) { if (!sameRef(a[i], v)) { push(out, a[i]); } } return out; }

// ----------------------------------------------------------------- Key --------
// A key is `0` (no key) or `{ value }` (a ValueKey). canUpdate compares runtime
// type + key, exactly like Flutter.
function ValueKey(v) { return { value: v }; }
function keyStr(k) { if (k == 0) { return ""; } if (has(k, "value")) { return concat("k:", str(k.value)); } return ""; }
function keyEqual(a, b) {
    if (a == 0) { if (b == 0) { return true; } return false; }
    if (b == 0) { return false; }
    if (has(a, "value")) { if (has(b, "value")) { if (a.value == b.value) { return true; } } }
    return false;
}
function widgetsCanUpdate(oldW, newW) {
    if (oldW.typeName() != newW.typeName()) { return false; }
    return keyEqual(oldW.key, newW.key);
}

// --------------------------------------------------------------- Widget -------
class Widget {
    constructor(p) { this._id = nextObjId(); this.p = p; this.key = 0; if (isObj(p)) { if (has(p, "key")) { this.key = p.key; } } }
    typeName() { return "Widget"; }
    createElement() { return 0; }
}

// --------------------------------------------------------------- Element ------
// Element is also the BuildContext. Lifecycle: initial → active → defunct.
class Element {
    constructor(widget) {
        this._id = nextObjId();
        this.widget = widget; this.parent = 0; this.owner = 0; this.slot = 0; this.depth = 0;
        this._lifecycleState = "initial"; this._dirty = 0.0; this._inDirtyList = 0.0;
        this._inheritedWidgets = 0; this._dependencies = 0;
    }
    isActive() { if (this._lifecycleState == "active") { return true; } return false; }
    mount(parent, slot) {
        this.parent = parent; this.slot = slot;
        if (parent != 0) { this.owner = parent.owner; this.depth = parent.depth + 1; this._inheritedWidgets = parent._inheritedWidgets; }
        this._lifecycleState = "active";
    }
    update(newWidget) { this.widget = newWidget; }
    rebuild() { if (this.isActive()) { if (this._dirty > 0.5) { this.performRebuild(); } } }
    performRebuild() { this._dirty = 0.0; }
    markNeedsBuild() {
        if (!this.isActive()) { return 0; }
        if (this._dirty > 0.5) { return 0; }
        this._dirty = 1.0;
        if (this.owner != 0) { this.owner.scheduleBuildFor(this); }
    }
    visitChildren(fn) { return 0; }
    forgetChild(child) { return 0; }
    // The reconciliation core (Flutter Element.updateChild).
    updateChild(child, newWidget, slot) {
        if (isNull(newWidget)) { newWidget = 0; }
        if (newWidget == 0) { if (child != 0) { this.deactivateChild(child); } return 0; }
        if (child != 0) {
            if (sameRef(child.widget, newWidget)) { child.slot = slot; return child; }
            if (widgetsCanUpdate(child.widget, newWidget)) { child.slot = slot; child.update(newWidget); return child; }
            this.deactivateChild(child);
            return this.inflateWidget(newWidget, slot);
        }
        return this.inflateWidget(newWidget, slot);
    }
    inflateWidget(newWidget, slot) {
        let element = newWidget.createElement();
        element.mount(this, slot);
        return element;
    }
    deactivateChild(child) { child.parent = 0; child.unmount(); }
    unmount() {
        this.visitChildren((c) => { c.unmount(); });
        this._lifecycleState = "defunct";
    }
    // Find the render object this element contributes (its own, or a descendant's).
    findRenderObject() { return 0; }
    // Thread parent-data widgets down onto a child render object (overridden by
    // ParentDataElement); default threads through to the single child element.
    applyParentData(ro) { return 0; }

    // ---- BuildContext: inherited widgets ----
    dependOnInheritedWidgetOfExactType(type) {
        let m = this._inheritedWidgets; if (m == 0) { return 0; }
        if (!has(m, type)) { return 0; }
        let ancestor = m[type];
        ancestor.addDependent(this);
        if (this._dependencies == 0) { this._dependencies = []; }
        push(this._dependencies, ancestor);
        return ancestor.widget;
    }
    didChangeDependencies() { this.markNeedsBuild(); }
}

// ------------------------------------------------------- ComponentElement -----
// An element that builds another widget (Stateless / Stateful / Proxy).
class ComponentElement extends Element {
    constructor(widget) { super(widget); this._child = 0; }
    mount(parent, slot) { super.mount(parent, slot); this.firstBuild(); }
    firstBuild() { this._dirty = 1.0; this.rebuild(); }
    performRebuild() {
        this._dirty = 0.0;
        let built = this.build();
        this._child = this.updateChild(this._child, built, this.slot);
    }
    build() { return 0; }
    visitChildren(fn) { if (this._child != 0) { fn(this._child); } }
    findRenderObject() { if (this._child != 0) { return this._child.findRenderObject(); } return 0; }
    applyParentData(ro) { if (this._child != 0) { this._child.applyParentData(ro); } }
}

// ---- StatelessWidget / StatelessElement ----
class StatelessElement extends ComponentElement {
    constructor(widget) { super(widget); }
    build() { return this.widget.build(this); }
    update(newWidget) { super.update(newWidget); this._dirty = 1.0; this.rebuild(); }
}
class StatelessWidget extends Widget {
    constructor(p) { super(p); }
    typeName() { return "StatelessWidget"; }
    createElement() { return new StatelessElement(this); }
    build(context) { return 0; }
}

// ---- StatefulWidget / State / StatefulElement ----
class State {
    constructor() { this.widget = 0; this.element = 0; this._mounted = 0.0; }
    initState() { return 0; }
    didChangeDependencies() { return 0; }
    didUpdateWidget(oldWidget) { return 0; }
    setState(fn) { fn(); this.element.markNeedsBuild(); }
    build(context) { return 0; }
    dispose() { return 0; }
    context() { return this.element; }
}
class StatefulElement extends ComponentElement {
    constructor(widget) {
        super(widget);
        this.state = widget.createState();
        this.state.widget = widget; this.state.element = this; this.state._mounted = 1.0;
    }
    build() { return this.state.build(this); }
    firstBuild() { this.state.initState(); this.state.didChangeDependencies(); super.firstBuild(); }
    update(newWidget) {
        super.update(newWidget);
        let oldW = this.state.widget; this.state.widget = newWidget;
        this.state.didUpdateWidget(oldW);
        this._dirty = 1.0; this.rebuild();
    }
    unmount() { super.unmount(); this.state.dispose(); this.state._mounted = 0.0; }
    didChangeDependencies() { super.didChangeDependencies(); this.state.didChangeDependencies(); }
}
class StatefulWidget extends Widget {
    constructor(p) { super(p); }
    typeName() { return "StatefulWidget"; }
    createElement() { return new StatefulElement(this); }
    createState() { return new State(); }
}

// ---- ProxyWidget / ParentDataWidget / InheritedWidget ----
class ProxyElement extends ComponentElement {
    constructor(widget) { super(widget); }
    build() { return this.widget.child; }
    update(newWidget) { let old = this.widget; super.update(newWidget); this.updated(old); this._dirty = 1.0; this.rebuild(); }
    updated(oldWidget) { return 0; }
}
class ProxyWidget extends Widget {
    constructor(p) { super(p); this.child = 0; if (isObj(p)) { if (has(p, "child")) { this.child = p.child; } } }
    typeName() { return "ProxyWidget"; }
}

// ParentDataWidget: configures the parent-data of the child render object (e.g.
// Expanded, Positioned). Its element threads applyParentData down to the child.
class ParentDataElement extends ProxyElement {
    constructor(widget) { super(widget); }
    applyParentData(ro) { this.widget.applyParentData(ro); if (this._child != 0) { this._child.applyParentData(ro); } }
}
class ParentDataWidget extends ProxyWidget {
    constructor(p) { super(p); }
    typeName() { return "ParentDataWidget"; }
    createElement() { return new ParentDataElement(this); }
    applyParentData(ro) { return 0; }
}

// InheritedWidget: propagates data down the tree; dependents rebuild when it
// changes (updateShouldNotify).
class InheritedElement extends ProxyElement {
    constructor(widget) { super(widget); this._dependents = []; }
    mount(parent, slot) {
        super.mount(parent, slot);
        // Copy the inherited map and register this element under its type.
        let m = {}; let pm = 0; if (parent != 0) { pm = parent._inheritedWidgets; }
        if (pm != 0) { let ks = keys(pm); for (let i = 0; i < len(ks); i++) { m[ks[i]] = pm[ks[i]]; } }
        m[this.widget.typeName()] = this;
        this._inheritedWidgets = m;
    }
    addDependent(e) { if (!arrContains(this._dependents, e)) { push(this._dependents, e); } }
    updated(oldWidget) {
        if (this.widget.updateShouldNotify(oldWidget)) {
            for (let i = 0; i < len(this._dependents); i++) { this._dependents[i].didChangeDependencies(); }
        }
    }
}
class InheritedWidget extends ProxyWidget {
    constructor(p) { super(p); }
    typeName() { return "InheritedWidget"; }
    createElement() { return new InheritedElement(this); }
    updateShouldNotify(oldWidget) { return true; }
}

// ------------------------------------------------- RenderObjectElement --------
// The element that owns a render object. Children's render objects are wired into
// this one after build/reconcile (single: setChild; multi: syncChildren), which
// preserves render-object identity (and layout caching) across rebuilds — the
// observable behaviour of Flutter's insert/move/remove slot protocol.
class RenderObjectElement extends Element {
    constructor(widget) { super(widget); this._renderObject = 0; }
    mount(parent, slot) {
        super.mount(parent, slot);
        this._renderObject = this.widget.createRenderObject(this);
        this.widget.updateRenderObject(this, this._renderObject);
        this._dirty = 0.0;
    }
    update(newWidget) { super.update(newWidget); this.widget.updateRenderObject(this, this._renderObject); this._dirty = 0.0; }
    performRebuild() { this._dirty = 0.0; this.widget.updateRenderObject(this, this._renderObject); }
    findRenderObject() { return this._renderObject; }
}

// Leaf (no children): Text/RawImage backing.
class LeafRenderObjectElement extends RenderObjectElement {
    constructor(widget) { super(widget); }
}

// Single child.
class SingleChildRenderObjectElement extends RenderObjectElement {
    constructor(widget) { super(widget); this._child = 0; }
    mount(parent, slot) { super.mount(parent, slot); this.rebuildChild(); }
    update(newWidget) { super.update(newWidget); this.rebuildChild(); }
    rebuildChild() {
        this._child = this.updateChild(this._child, this.widget.child, "child");
        let cro = 0; if (this._child != 0) { cro = this._child.findRenderObject(); }
        this._renderObject.setChild(cro);
        if (this._child != 0) { if (cro != 0) { this._child.applyParentData(cro); } }
    }
    visitChildren(fn) { if (this._child != 0) { fn(this._child); } }
    findRenderObject() { return this._renderObject; }
}

// Multi child: full reconciliation + render-object child sync.
class MultiChildRenderObjectElement extends RenderObjectElement {
    constructor(widget) { super(widget); this._children = []; }
    mount(parent, slot) {
        super.mount(parent, slot);
        let widgets = this.widget.children;
        let kids = [];
        for (let i = 0; i < len(widgets); i++) { push(kids, this.inflateWidget(widgets[i], i)); }
        this._children = kids;
        this.syncRenderChildren();
    }
    update(newWidget) {
        super.update(newWidget);
        this._children = this.updateChildren(this._children, this.widget.children);
        this.syncRenderChildren();
    }
    visitChildren(fn) { for (let i = 0; i < len(this._children); i++) { fn(this._children[i]); } }
    findRenderObject() { return this._renderObject; }
    // Collect each child element's render object (in order), apply parent data,
    // and sync them into the render object — preserving identity for reused ones.
    syncRenderChildren() {
        let ros = [];
        for (let i = 0; i < len(this._children); i++) {
            let ce = this._children[i]; let ro = ce.findRenderObject();
            if (ro != 0) { push(ros, ro); }
        }
        this._renderObject.syncChildren(ros);
        for (let i = 0; i < len(this._children); i++) {
            let ce = this._children[i]; let ro = ce.findRenderObject();
            if (ro != 0) { ce.applyParentData(ro); }
        }
    }
    // Flutter's children-list reconciliation (top sync → bottom sync → keyed
    // middle), returning the new element list.
    updateChildren(oldChildren, newWidgets) {
        let oldLen = len(oldChildren); let newLen = len(newWidgets);
        let newChildren = [];
        for (let i = 0; i < newLen; i++) { push(newChildren, 0); }
        let oldStart = 0; let newStart = 0; let oldEnd = oldLen - 1; let newEnd = newLen - 1;
        // Top sync.
        for (let g = 0; g < oldLen + newLen; g++) {
            if (oldStart > oldEnd) { g = oldLen + newLen; }
            else { if (newStart > newEnd) { g = oldLen + newLen; }
            else {
                if (!widgetsCanUpdate(oldChildren[oldStart].widget, newWidgets[newStart])) { g = oldLen + newLen; }
                else { newChildren[newStart] = this.updateChild(oldChildren[oldStart], newWidgets[newStart], newStart); newStart = newStart + 1; oldStart = oldStart + 1; }
            } }
        }
        // Bottom scan (matched count); synced after the middle.
        let bottomOld = oldEnd; let bottomNew = newEnd;
        for (let g = 0; g < oldLen + newLen; g++) {
            if (oldStart > oldEnd) { g = oldLen + newLen; }
            else { if (newStart > newEnd) { g = oldLen + newLen; }
            else {
                if (!widgetsCanUpdate(oldChildren[oldEnd].widget, newWidgets[newEnd])) { g = oldLen + newLen; }
                else { oldEnd = oldEnd - 1; newEnd = newEnd - 1; }
            } }
        }
        // Middle: build the old keyed map, deactivate unkeyed leftovers.
        let haveOld = 0.0; if (oldStart <= oldEnd) { haveOld = 1.0; }
        let oldKeyed = {};
        if (haveOld > 0.5) {
            for (let i = oldStart; i <= oldEnd; i++) {
                let o = oldChildren[i]; let ks = keyStr(o.widget.key);
                if (len(ks) > 0) { oldKeyed[ks] = o; } else { this.deactivateChild(o); }
            }
        }
        // Middle: inflate / update new children, matching keyed olds.
        for (let i = newStart; i <= newEnd; i++) {
            let nw = newWidgets[i]; let oldChild = 0;
            let ks = keyStr(nw.key);
            if (len(ks) > 0) { if (has(oldKeyed, ks)) { let cand = oldKeyed[ks]; if (widgetsCanUpdate(cand.widget, nw)) { oldChild = cand; oldKeyed[ks] = 0; } } }
            newChildren[i] = this.updateChild(oldChild, nw, i);
        }
        // Deactivate any unmatched keyed olds.
        let rem = keys(oldKeyed);
        for (let i = 0; i < len(rem); i++) { let o = oldKeyed[rem[i]]; if (o != 0) { this.deactivateChild(o); } }
        // Bottom sync (the matched tail).
        let j = bottomNew; let oj = bottomOld;
        for (let g = 0; g < oldLen + newLen; g++) {
            if (j <= newEnd) { g = oldLen + newLen; }
            else { newChildren[j] = this.updateChild(oldChildren[oj], newWidgets[j], j); j = j - 1; oj = oj - 1; }
        }
        return newChildren;
    }
}

// ---- RenderObjectWidget bases ----
class RenderObjectWidget extends Widget {
    constructor(p) { super(p); }
    typeName() { return "RenderObjectWidget"; }
    createRenderObject(context) { return 0; }
    updateRenderObject(context, ro) { return 0; }
}
class LeafRenderObjectWidget extends RenderObjectWidget {
    constructor(p) { super(p); }
    createElement() { return new LeafRenderObjectElement(this); }
}
class SingleChildRenderObjectWidget extends RenderObjectWidget {
    constructor(p) { super(p); this.child = 0; if (isObj(p)) { if (has(p, "child")) { this.child = p.child; } } }
    createElement() { return new SingleChildRenderObjectElement(this); }
}
class MultiChildRenderObjectWidget extends RenderObjectWidget {
    constructor(p) { super(p); this.children = []; if (isObj(p)) { if (has(p, "children")) { this.children = p.children; } } }
    createElement() { return new MultiChildRenderObjectElement(this); }
}

// ------------------------------------------------------------- BuildOwner -----
class BuildOwner {
    constructor() { this.dirty = []; }
    scheduleBuildFor(e) {
        if (e._inDirtyList > 0.5) { return 0; }
        e._inDirtyList = 1.0; push(this.dirty, e);
        WB.scheduleFrame();
    }
    // Rebuild dirty elements in ascending depth order (parents before children).
    buildScope(context) {
        if (len(this.dirty) == 0) { return 0; }
        for (let pass = 0; pass < 16; pass++) {
            if (len(this.dirty) == 0) { return 0; }
            let list = this.dirty; this.dirty = [];
            sortByDepth(list);
            for (let i = 0; i < len(list); i++) {
                let e = list[i]; e._inDirtyList = 0.0;
                if (e._dirty > 0.5) { e.rebuild(); }
            }
        }
        return 0;
    }
}

// The render-object/element bridge for the tree root: wires the app element's
// render object into the binding's RenderView (Flutter's RenderObjectToWidget).
class RootElement extends Element {
    constructor(widget) { super(widget); this._child = 0; }
    mountRoot(owner) {
        this.owner = owner; this.depth = 0; this._lifecycleState = "active";
        this._child = this.updateChild(this._child, this.widget.child, "root");
        let ro = 0; if (this._child != 0) { ro = this._child.findRenderObject(); }
        WB.setRoot(ro);
    }
    performRebuild() {
        this._dirty = 0.0;
        this._child = this.updateChild(this._child, this.widget.child, "root");
    }
    visitChildren(fn) { if (this._child != 0) { fn(this._child); } }
    findRenderObject() { if (this._child != 0) { return this._child.findRenderObject(); } return 0; }
}
class RootWidget extends Widget {
    constructor(child) { super(0); this.child = child; }
    typeName() { return "RootWidget"; }
}
