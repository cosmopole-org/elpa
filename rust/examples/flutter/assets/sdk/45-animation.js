// Elpa Flutter — the animation layer (package:flutter/animation + scheduler).
//
// A faithful, frame-time-driven animation system: a `SchedulerBinding` that ticks
// every active `AnimationController` once per host frame (with the real elapsed
// dt, so motion is frame-rate independent and smooth), the `Curves` catalog
// (cubic-bezier + physical curves), `Tween`/`ColorTween`, `CurvedAnimation`, and
// the widget-facing motion primitives: `AnimatedBuilder`, `TweenAnimationBuilder`,
// the explicit transitions (Fade/Scale/Rotation/Slide/Size), and the implicitly
// animated widgets (AnimatedContainer/Opacity/Align/Padding/Scale/Rotation/
// Positioned). Listeners mark their element dirty → the BuildOwner rebuilds only
// that subtree → one cheap partial frame, exactly like Flutter.

let _TAU = 6.283185307179586;

// ----------------------------------------------------------- SchedulerBinding -
// Holds the set of objects that want a per-frame tick. The binding calls
// `tick(dtMs)` from onFrame; while any ticker is active the binding keeps
// scheduling frames (Flutter's SchedulerBinding + Ticker).
class SchedulerBinding {
    constructor() { this.tickers = []; }
    _has(t) { for (let i = 0; i < len(this.tickers); i++) { if (sameRef(this.tickers[i], t)) { return true; } } return false; }
    add(t) { if (!this._has(t)) { push(this.tickers, t); WB.scheduleFrame(); } }
    remove(t) { this.tickers = arrRemoveVal(this.tickers, t); }
    tick(dtMs) {
        if (len(this.tickers) == 0) { return 0.0; }
        let list = slice(this.tickers, 0, len(this.tickers));
        for (let i = 0; i < len(list); i++) { list[i].tickFrame(dtMs); }
        if (len(this.tickers) > 0) { return 1.0; }
        return 0.0;
    }
}
let SCHED = new SchedulerBinding();

// ------------------------------------------------------------------- Curves ---
// Cubic-bezier easing solved by Newton iteration on x (Flutter's Cubic). Plus
// the physical curves (decelerate, bounce, elastic) used across Material.
function _bezAxis(a, b, s) { let u = 1.0 - s; return 3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s; }
function _bezDeriv(a, b, s) { let u = 1.0 - s; return 3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b); }
function cubicCurve(x1, y1, x2, y2) {
    return (t) => {
        if (t <= 0.0) { return 0.0; }
        if (t >= 1.0) { return 1.0; }
        let s = t;
        for (let i = 0; i < 8; i++) {
            let x = _bezAxis(x1, x2, s) - t;
            let d = _bezDeriv(x1, x2, s);
            if (abs(d) < 0.000001) { i = 8; } else { s = s - x / d; }
        }
        s = clamp01(s);
        return _bezAxis(y1, y2, s);
    };
}
function _bounceOut(t) {
    if (t < 0.36363636) { return 7.5625 * t * t; }
    if (t < 0.72727272) { let u = t - 0.54545454; return 7.5625 * u * u + 0.75; }
    if (t < 0.90909090) { let u = t - 0.81818181; return 7.5625 * u * u + 0.9375; }
    let u = t - 0.95454545; return 7.5625 * u * u + 0.984375;
}
function _elasticOut(t) {
    if (t <= 0.0) { return 0.0; } if (t >= 1.0) { return 1.0; }
    let p = 0.4; return pow(2.0, -10.0 * t) * sin((t - p / 4.0) * _TAU / p) + 1.0;
}
let Curves = {
    linear: (t) => t,
    ease: cubicCurve(0.25, 0.1, 0.25, 1.0),
    easeIn: cubicCurve(0.42, 0.0, 1.0, 1.0),
    easeOut: cubicCurve(0.0, 0.0, 0.58, 1.0),
    easeInOut: cubicCurve(0.42, 0.0, 0.58, 1.0),
    easeInOutCubic: cubicCurve(0.645, 0.045, 0.355, 1.0),
    fastOutSlowIn: cubicCurve(0.4, 0.0, 0.2, 1.0),
    slowMiddle: cubicCurve(0.15, 0.85, 0.85, 0.15),
    decelerate: (t) => { let u = 1.0 - t; return 1.0 - u * u; },
    bounceOut: (t) => _bounceOut(t),
    bounceIn: (t) => 1.0 - _bounceOut(1.0 - t),
    elasticOut: (t) => _elasticOut(t),
};

// ---------------------------------------------------------------- Animation ---
class Animation {
    constructor() { this._id = nextObjId(); this.listeners = []; this.statusListeners = []; }
    value() { return 0.0; }
    status() { return "dismissed"; }
    isCompleted() { return this.status() == "completed"; }
    isDismissed() { return this.status() == "dismissed"; }
    addListener(fn) { push(this.listeners, fn); }
    removeListener(fn) { this.listeners = arrRemoveVal(this.listeners, fn); }
    addStatusListener(fn) { push(this.statusListeners, fn); }
    removeStatusListener(fn) { this.statusListeners = arrRemoveVal(this.statusListeners, fn); }
    notify() { let l = slice(this.listeners, 0, len(this.listeners)); for (let i = 0; i < len(l); i++) { l[i](); } }
    notifyStatus(s) { let l = slice(this.statusListeners, 0, len(this.statusListeners)); for (let i = 0; i < len(l); i++) { l[i](s); } }
    drive(tween) { return tween.animate(this); }
}

// ------------------------------------------------------- AnimationController ---
// The clock-driven value source. Goes from `lowerBound` to `upperBound` over
// `duration` (ms). forward/reverse/repeat/animateTo move it; each frame's tick
// advances it by the real elapsed dt and notifies listeners.
class AnimationController extends Animation {
    constructor(p) {
        super();
        if (isNull(p)) { p = {}; }
        this.duration = 300.0; if (has(p, "duration")) { this.duration = p.duration; }
        this.reverseDuration = -1.0; if (has(p, "reverseDuration")) { this.reverseDuration = p.reverseDuration; }
        this.lowerBound = 0.0; if (has(p, "lowerBound")) { this.lowerBound = p.lowerBound; }
        this.upperBound = 1.0; if (has(p, "upperBound")) { this.upperBound = p.upperBound; }
        this._v = this.lowerBound; if (has(p, "value")) { this._v = p.value; }
        this._status = "dismissed";
        this._dir = 0.0; this._targetV = this.upperBound;
        this._running = 0.0; this._repeat = 0.0; this._repeatReverse = 0.0;
    }
    value() { return this._v; }
    setValue(v) { this._v = v; this.notify(); }
    status() { return this._status; }
    _emitStatus(s) { this._status = s; this.notifyStatus(s); }
    _begin(dir) {
        this._dir = dir; this._running = 1.0;
        SCHED.add(this);
        this._emitStatus(dir > 0.0 ? "forward" : "reverse");
        return this;
    }
    forward(from) { if (!isNull(from)) { this._v = from; } this._targetV = this.upperBound; this._repeat = 0.0; return this._begin(1.0); }
    reverse(from) { if (!isNull(from)) { this._v = from; } this._targetV = this.lowerBound; this._repeat = 0.0; return this._begin(-1.0); }
    animateTo(target, dur) { if (!isNull(dur)) { this.duration = dur; } this._targetV = target; this._repeat = 0.0; return this._begin(target >= this._v ? 1.0 : -1.0); }
    repeat(p) {
        this._repeat = 1.0; this._repeatReverse = 0.0;
        if (!isNull(p)) { if (has(p, "reverse")) { if (p.reverse) { this._repeatReverse = 1.0; } } }
        this._v = this.lowerBound; this._targetV = this.upperBound;
        return this._begin(1.0);
    }
    stop() { this._running = 0.0; SCHED.remove(this); }
    reset() { this.stop(); this._v = this.lowerBound; this._emitStatus("dismissed"); }
    dispose() { this.stop(); this.listeners = []; this.statusListeners = []; }
    tickFrame(dt) {
        if (this._running < 0.5) { return 0; }
        let dur = this.duration;
        if (this._dir < 0.0) { if (this.reverseDuration > 0.0) { dur = this.reverseDuration; } }
        if (dur <= 0.0) { dur = 1.0; }
        let step = (this.upperBound - this.lowerBound) * (dt / dur) * this._dir;
        this._v = this._v + step;
        let done = 0.0;
        if (this._dir > 0.0) { if (this._v >= this._targetV) { this._v = this._targetV; done = 1.0; } }
        else { if (this._v <= this._targetV) { this._v = this._targetV; done = 1.0; } }
        this.notify();
        if (done > 0.5) { this._handleDone(); }
        return 0;
    }
    _handleDone() {
        if (this._repeat > 0.5) {
            if (this._repeatReverse > 0.5) {
                this._dir = -this._dir;
                this._targetV = this._dir > 0.0 ? this.upperBound : this.lowerBound;
                this._emitStatus(this._dir > 0.0 ? "forward" : "reverse");
            } else {
                this._v = this.lowerBound;
            }
            return 0;
        }
        this._running = 0.0; SCHED.remove(this);
        this._emitStatus(this._dir > 0.0 ? "completed" : "dismissed");
    }
}

// ------------------------------------------------------- CurvedAnimation ------
class CurvedAnimation extends Animation {
    constructor(parent, curve, reverseCurve) {
        super(); this.parent = parent; this.curve = curve; this.reverseCurve = 0;
        if (!isNull(reverseCurve)) { this.reverseCurve = reverseCurve; }
        let self = this;
        parent.addListener(() => { self.notify(); });
        parent.addStatusListener((s) => { self.notifyStatus(s); });
    }
    value() {
        let c = this.curve;
        if (this.reverseCurve != 0) { if (this.parent.status() == "reverse") { c = this.reverseCurve; } }
        return c(this.parent.value());
    }
    status() { return this.parent.status(); }
}

// --------------------------------------------------------------- Tween --------
class Tween {
    constructor(begin, end) { this.begin = begin; this.end = end; }
    lerp(t) { return this.begin + (this.end - this.begin) * t; }
    transform(t) { return this.lerp(t); }
    evaluate(animation) { return this.lerp(animation.value()); }
    animate(animation) { return new TweenAnimation(this, animation); }
    chain(curve) { return new CurveTween(this, curve); }
}
class ColorTween extends Tween {
    constructor(begin, end) { super(begin, end); }
    lerp(t) { return lerpCol(this.begin, this.end, t); }
}
// An Animation whose value is `tween.lerp(parent.value())` (Tween.animate).
class TweenAnimation extends Animation {
    constructor(tween, parent) {
        super(); this.tween = tween; this.parent = parent;
        let self = this;
        parent.addListener(() => { self.notify(); });
        parent.addStatusListener((s) => { self.notifyStatus(s); });
    }
    value() { return this.tween.lerp(this.parent.value()); }
    status() { return this.parent.status(); }
}
class CurveTween extends Animation {
    constructor(tween, curve) { super(); this.tween = tween; this.curve = curve; }
    animate(parent) { let self = this; return new CurveTweenAnimation(self, parent); }
}
class CurveTweenAnimation extends Animation {
    constructor(ct, parent) {
        super(); this.ct = ct; this.parent = parent;
        let self = this; parent.addListener(() => { self.notify(); }); parent.addStatusListener((s) => { self.notifyStatus(s); });
    }
    value() { return this.ct.tween.lerp(this.ct.curve(this.parent.value())); }
    status() { return this.parent.status(); }
}

// A constant always-the-same animation (Flutter's kAlwaysCompleteAnimation peer).
class AlwaysStoppedAnimation extends Animation {
    constructor(v) { super(); this._val = v; }
    value() { return this._val; }
    status() { return "forward"; }
}

// ----------------------------------------------------- AnimatedBuilder ---------
// Rebuilds `builder(context, child)` whenever `animation` notifies. The `child`
// is built once and passed through, so the non-animating subtree is not rebuilt
// (Flutter's AnimatedBuilder optimization).
class AnimatedBuilderWidget extends StatefulWidget {
    constructor(p) { super(p); this.animation = p.animation; this.builder = p.builder; this.child = 0; if (has(p, "child")) { this.child = p.child; } }
    typeName() { return "AnimatedBuilder"; }
    createState() { return new AnimatedBuilderState(); }
}
class AnimatedBuilderState extends State {
    initState() { let self = this; this._listener = () => { self.setState(() => { }); }; this.widget.animation.addListener(this._listener); }
    didUpdateWidget(old) {
        if (!sameRef(old.animation, this.widget.animation)) {
            old.animation.removeListener(this._listener);
            this.widget.animation.addListener(this._listener);
        }
    }
    dispose() { this.widget.animation.removeListener(this._listener); }
    build(context) { return this.widget.builder(context, this.widget.child); }
}
function AnimatedBuilder(p) { return new AnimatedBuilderWidget(p); }
function Listenable() { return 0; }

// ------------------------------------------------ TweenAnimationBuilder --------
// Drives an internal controller so `builder(context, value, child)` re-runs with
// the tween value smoothly animating to `tween.end` whenever it changes.
class TweenAnimationBuilderWidget extends StatefulWidget {
    constructor(p) {
        super(p); this.tween = p.tween; this.builder = p.builder;
        this.duration = 300.0; if (has(p, "duration")) { this.duration = p.duration; }
        this.curve = Curves.linear; if (has(p, "curve")) { this.curve = p.curve; }
        this.child = 0; if (has(p, "child")) { this.child = p.child; }
    }
    typeName() { return "TweenAnimationBuilder"; }
    createState() { return new TweenAnimationBuilderState(); }
}
class TweenAnimationBuilderState extends State {
    initState() {
        let self = this;
        this.controller = new AnimationController({ duration: this.widget.duration });
        this.curveAnim = new CurvedAnimation(this.controller, this.widget.curve);
        this.controller.addListener(() => { self.setState(() => { }); });
        this.begin = this.widget.tween.begin; this.end = this.widget.tween.end;
        this.controller._v = 1.0;
    }
    didUpdateWidget(old) {
        this.controller.duration = this.widget.duration;
        if (this.widget.tween.end != this.end) {
            this.begin = this.currentValue();
            this.end = this.widget.tween.end;
            this.controller.forward(0.0);
        }
    }
    currentValue() { return lerpAny(this.begin, this.end, this.curveAnim.value()); }
    dispose() { this.controller.dispose(); }
    build(context) { return this.widget.builder(context, this.currentValue(), this.widget.child); }
}
function TweenAnimationBuilder(p) { return new TweenAnimationBuilderWidget(p); }
// Interpolate numbers or rgba colour arrays.
function lerpAny(a, b, t) { if (typeOf(a) == "array") { return lerpCol(a, b, t); } return a + (b - a) * t; }

// --------------------------------------------------------- transitions ---------
function FadeTransition(p) {
    let a = p.opacity; let child = 0; if (has(p, "child")) { child = p.child; }
    return AnimatedBuilder({ animation: a, child: child, builder: (ctx, c) => Opacity({ opacity: clamp01(a.value()), child: c }) });
}
function ScaleTransition(p) {
    let a = p.scale; let child = 0; if (has(p, "child")) { child = p.child; }
    return AnimatedBuilder({ animation: a, child: child, builder: (ctx, c) => Transform({ scale: a.value(), child: c }) });
}
function RotationTransition(p) {
    let a = p.turns; let child = 0; if (has(p, "child")) { child = p.child; }
    return AnimatedBuilder({ animation: a, child: child, builder: (ctx, c) => Transform({ angle: a.value() * _TAU, child: c }) });
}
function SlideTransition(p) {
    let a = p.position; let child = 0; if (has(p, "child")) { child = p.child; }
    return AnimatedBuilder({ animation: a, child: child, builder: (ctx, c) => { let o = a.value(); return FractionalTranslation({ dx: o.dx, dy: o.dy, child: c }); } });
}
function SizeTransition(p) {
    let a = p.sizeFactor; let axis = "vertical"; if (has(p, "axis")) { axis = p.axis; }
    let child = 0; if (has(p, "child")) { child = p.child; }
    return AnimatedBuilder({ animation: a, child: child, builder: (ctx, c) => {
        let v = max(0.0, a.value());
        if (axis == "horizontal") { return ClipRect({ child: Align({ alignment: Alignments.centerLeft, widthFactor: v, child: c }) }); }
        return ClipRect({ child: Align({ alignment: Alignments.topCenter, heightFactor: v, child: c }) });
    } });
}

// ---- FractionalTranslation render object + widget (SlideTransition backing) ---
class RenderFractionalTranslation extends RenderProxyBox {
    constructor(fx, fy) { super(); this.fx = fx; this.fy = fy; }
    paint(context, off) {
        if (this.child == 0) { return 0; }
        context.paintChild(this.child, new Offset(off.dx + this.fx * this.size.width, off.dy + this.fy * this.size.height));
    }
    hitTestChildren(result, pos) {
        if (this.child != 0) {
            let dx = this.fx * this.size.width; let dy = this.fy * this.size.height;
            return this.child.hitTest(result, new Offset(pos.dx - dx, pos.dy - dy));
        }
        return false;
    }
}
class FractionalTranslationWidget extends SingleChildRenderObjectWidget {
    constructor(p) { super(p); this.fx = 0.0; this.fy = 0.0; if (has(p, "dx")) { this.fx = p.dx; } if (has(p, "dy")) { this.fy = p.dy; } }
    typeName() { return "FractionalTranslation"; }
    createRenderObject(context) { return new RenderFractionalTranslation(this.fx, this.fy); }
    updateRenderObject(context, ro) { ro.fx = this.fx; ro.fy = this.fy; ro.markNeedsPaint(); }
}
function FractionalTranslation(p) { return new FractionalTranslationWidget(p); }

// ------------------------------------------------- implicit animations ---------
// Base state: owns a controller + curve, snapshots the animated properties as
// {begin,end} tweens, and re-targets (begin = current visual value) whenever a
// target changes — exactly Flutter's ImplicitlyAnimatedWidget/forEachTween.
class ImplicitlyAnimatedWidget extends StatefulWidget {
    constructor(p) {
        super(p);
        this.duration = 300.0; if (has(p, "duration")) { this.duration = p.duration; }
        this.curve = Curves.linear; if (has(p, "curve")) { this.curve = p.curve; }
        this.child = 0; if (has(p, "child")) { this.child = p.child; }
    }
}
class ImplicitlyAnimatedState extends State {
    initState() {
        let self = this;
        this.controller = new AnimationController({ duration: this.widget.duration });
        this.curveAnim = new CurvedAnimation(this.controller, this.widget.curve);
        this.controller.addListener(() => { self.setState(() => { }); });
        this.tweens = {};
        let tg = this.targets();
        let ks = keys(tg);
        for (let i = 0; i < len(ks); i++) { let nm = ks[i]; this.tweens[nm] = { b: tg[nm], e: tg[nm] }; }
        this.controller._v = 1.0;
    }
    didUpdateWidget(old) {
        this.controller.duration = this.widget.duration;
        let tg = this.targets(); let ks = keys(tg); let changed = 0.0;
        for (let i = 0; i < len(ks); i++) {
            let nm = ks[i]; let nt = tg[nm]; let tw = this.tweens[nm];
            if (isNull(tw)) { this.tweens[nm] = { b: nt, e: nt }; }
            else { if (nt != tw.e) { tw.b = lerpAny(tw.b, tw.e, this.curveAnim.value()); tw.e = nt; changed = 1.0; } }
        }
        if (changed > 0.5) { this.controller.forward(0.0); }
    }
    val(nm) { let tw = this.tweens[nm]; return lerpAny(tw.b, tw.e, this.curveAnim.value()); }
    dispose() { this.controller.dispose(); }
    targets() { return {}; }
}

class AnimatedContainerWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedContainer"; }
    createState() { return new AnimatedContainerState(); }
}
class AnimatedContainerState extends ImplicitlyAnimatedState {
    targets() {
        let p = this.widget.p; let t = {};
        t.w = has(p, "width") ? p.width : -1.0;
        t.h = has(p, "height") ? p.height : -1.0;
        t.r = has(p, "borderRadius") ? p.borderRadius : 0.0;
        t.col = has(p, "color") ? p.color : CLEAR;
        t.ax = 0.0; t.ay = 0.0;
        if (has(p, "alignment")) { t.ax = p.alignment.x; t.ay = p.alignment.y; }
        return t;
    }
    build(context) {
        let p = this.widget.p;
        let q = { width: this.val("w"), height: this.val("h"), color: this.val("col"), borderRadius: this.val("r") };
        if (has(p, "alignment")) { q.alignment = new Alignment(this.val("ax"), this.val("ay")); }
        if (has(p, "padding")) { q.padding = p.padding; }
        if (has(p, "child")) { q.child = p.child; }
        if (has(p, "boxShadow")) { q.decoration = { color: this.val("col"), borderRadius: this.val("r"), boxShadow: p.boxShadow }; q.color = 0; }
        return Container(q);
    }
}
function AnimatedContainer(p) { return new AnimatedContainerWidget(p); }

class AnimatedOpacityWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedOpacity"; }
    createState() { return new AnimatedOpacityState(); }
}
class AnimatedOpacityState extends ImplicitlyAnimatedState {
    targets() { return { o: this.widget.p.opacity }; }
    build(context) { return Opacity({ opacity: clamp01(this.val("o")), child: this.widget.child }); }
}
function AnimatedOpacity(p) { return new AnimatedOpacityWidget(p); }

class AnimatedAlignWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedAlign"; }
    createState() { return new AnimatedAlignState(); }
}
class AnimatedAlignState extends ImplicitlyAnimatedState {
    targets() { let a = this.widget.p.alignment; return { ax: a.x, ay: a.y }; }
    build(context) { return Align({ alignment: new Alignment(this.val("ax"), this.val("ay")), child: this.widget.child }); }
}
function AnimatedAlign(p) { return new AnimatedAlignWidget(p); }

class AnimatedPaddingWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedPadding"; }
    createState() { return new AnimatedPaddingState(); }
}
class AnimatedPaddingState extends ImplicitlyAnimatedState {
    targets() { let e = this.widget.p.padding; return { l: e.left, t: e.top, r: e.right, b: e.bottom }; }
    build(context) { return Padding({ padding: new EdgeInsets(this.val("l"), this.val("t"), this.val("r"), this.val("b")), child: this.widget.child }); }
}
function AnimatedPadding(p) { return new AnimatedPaddingWidget(p); }

class AnimatedScaleWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedScale"; }
    createState() { return new AnimatedScaleState(); }
}
class AnimatedScaleState extends ImplicitlyAnimatedState {
    targets() { return { s: this.widget.p.scale }; }
    build(context) { return Transform({ scale: this.val("s"), child: this.widget.child }); }
}
function AnimatedScale(p) { return new AnimatedScaleWidget(p); }

class AnimatedRotationWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedRotation"; }
    createState() { return new AnimatedRotationState(); }
}
class AnimatedRotationState extends ImplicitlyAnimatedState {
    targets() { return { t: this.widget.p.turns }; }
    build(context) { return Transform({ angle: this.val("t") * _TAU, child: this.widget.child }); }
}
function AnimatedRotation(p) { return new AnimatedRotationWidget(p); }

class AnimatedPositionedWidget extends ImplicitlyAnimatedWidget {
    constructor(p) { super(p); }
    typeName() { return "AnimatedPositioned"; }
    createState() { return new AnimatedPositionedState(); }
}
class AnimatedPositionedState extends ImplicitlyAnimatedState {
    targets() {
        let p = this.widget.p;
        return { l: has(p, "left") ? p.left : -1.0, t: has(p, "top") ? p.top : -1.0,
                 r: has(p, "right") ? p.right : -1.0, b: has(p, "bottom") ? p.bottom : -1.0,
                 w: has(p, "width") ? p.width : -1.0, h: has(p, "height") ? p.height : -1.0 };
    }
    build(context) {
        let p = this.widget.p; let q = { child: this.widget.child };
        if (has(p, "left")) { q.left = this.val("l"); } if (has(p, "top")) { q.top = this.val("t"); }
        if (has(p, "right")) { q.right = this.val("r"); } if (has(p, "bottom")) { q.bottom = this.val("b"); }
        if (has(p, "width")) { q.width = this.val("w"); } if (has(p, "height")) { q.height = this.val("h"); }
        return Positioned(q);
    }
}
function AnimatedPositioned(p) { return new AnimatedPositionedWidget(p); }
