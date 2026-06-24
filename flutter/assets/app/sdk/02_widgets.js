// =============================================================================
// Elpa SDK — Widgets
// -----------------------------------------------------------------------------
// An object-oriented wrapper over the Elpa Flutter DSL. Each widget is a small
// class with a fluent, chainable API that serializes to the wire node the Dart
// shell renders. Authoring a UI becomes composing objects instead of hand-writing
// nested JSON:
//
//   new Column([ new Text("Hi").bold().size(20), new Button("Go").on("onTap", f) ])
//       .center()
//
// `Widget.toJson(env)` is the single serialization seam: it emits `type`, `key`,
// `rev`, `boundary`, `props`, `events` (closures registered into the bus) and
// recursively-built `children`.
// =============================================================================

/// Base class for every widget. Holds the wire fields and the fluent setters.
class Widget {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this._key = NIL;
    this._rev = NIL;
    this._boundary = false;
    this._props = {};
    this._events = {};
    this._children = [];
  }

  withKey(k) { this._key = k; return this; }
  withRev(r) { this._rev = r; return this; }
  asBoundary() { this._boundary = true; return this; }
  on(event, fn) { this._events[event] = fn; return this; }
  prop(propName, val) { this._props[propName] = val; return this; }
  add(child) { push(this._children, child); return this; }
  kids(list) { this._children = list; return this; }

  /// Wrap in a `Padding`.
  padded(insets) { return new Padding(insets, this); }
  /// Wrap in an `Expanded` (fills the free main-axis space of a Row/Column).
  expanded(flex) { return new Expanded(this).flex(isNull(flex) ? 1 : flex); }
  /// Wrap in a `Center`.
  center() { return new Center(this); }

  toJson(env) {
    let node = { type: this.nodeType, props: this._props };
    if (!isNull(this._key)) node.key = this._key;
    if (!isNull(this._rev)) node.rev = this._rev;
    if (this._boundary) node.boundary = true;
    let evNames = keys(this._events);
    if (len(evNames) > 0) {
      let ev = {};
      for (let i = 0; i < len(evNames); i++) {
        let nm = evNames[i];
        ev[nm] = env.register(this._events[nm]);
      }
      node.events = ev;
    }
    if (len(this._children) > 0) {
      let arr = [];
      for (let i = 0; i < len(this._children); i++) {
        push(arr, this._children[i].toJson(env));
      }
      node.children = arr;
    }
    return node;
  }
}

// ---- Content ----------------------------------------------------------------

class Text extends Widget {
  constructor(content) {
    super("Text");
    this._props.text = isNull(content) ? "" : str(content);
    this._style = {};
  }
  size(s) { this._style.size = s; this._props.style = this._style; return this; }
  bold() { this._style.bold = true; this._props.style = this._style; return this; }
  italic() { this._style.italic = true; this._props.style = this._style; return this; }
  color(c) { this._style.color = c; this._props.style = this._style; return this; }
  align(a) { this._props.align = a; return this; }
  /// Clamp to one line with an ellipsis (chat-list previews / titles).
  oneLine() { this._props.maxLines = 1; this._props.ellipsis = true; return this; }
  maxLines(n) { this._props.maxLines = n; this._props.ellipsis = true; return this; }
}

class Icon extends Widget {
  constructor(name) {
    super("Icon");
    this._props.icon = name;
  }
  size(s) { this._props.size = s; return this; }
  color(c) { this._props.color = c; return this; }
}

class Img extends Widget {
  constructor(src) {
    super("Image");
    this._props.src = src;
  }
  fit(f) { this._props.fit = f; return this; }
}

// ---- Layout -----------------------------------------------------------------

class Column extends Widget {
  constructor(list) {
    super("Column");
    if (!isNull(list)) this._children = list;
  }
  mainAxis(a) { this._props.mainAxisAlignment = a; return this; }
  crossAxis(a) { this._props.crossAxisAlignment = a; return this; }
  shrink() { this._props.shrink = true; return this; }
}

class Row extends Widget {
  constructor(list) {
    super("Row");
    if (!isNull(list)) this._children = list;
  }
  mainAxis(a) { this._props.mainAxisAlignment = a; return this; }
  crossAxis(a) { this._props.crossAxisAlignment = a; return this; }
  shrink() { this._props.shrink = true; return this; }
}

class Stack extends Widget {
  constructor(list) {
    super("Stack");
    if (!isNull(list)) this._children = list;
  }
  alignment(a) { this._props.alignment = a; return this; }
}

class Positioned extends Widget {
  constructor(child) {
    super("Positioned");
    if (!isNull(child)) push(this._children, child);
  }
  at(left, top, right, bottom) {
    if (!isNull(left)) this._props.left = left;
    if (!isNull(top)) this._props.top = top;
    if (!isNull(right)) this._props.right = right;
    if (!isNull(bottom)) this._props.bottom = bottom;
    return this;
  }
}

class Container extends Widget {
  constructor(child) {
    super("Container");
    if (!isNull(child)) push(this._children, child);
  }
  width(w) { this._props.width = w; return this; }
  height(h) { this._props.height = h; return this; }
  size(w, h) { this._props.width = w; this._props.height = h; return this; }
  color(c) { this._props.color = c; return this; }
  radius(r) { this._props.radius = r; return this; }
  pad(insets) { this._props.padding = insets; return this; }
  margin(insets) { this._props.margin = insets; return this; }
  align(a) { this._props.alignment = a; return this; }
}

class Padding extends Widget {
  constructor(insets, child) {
    super("Padding");
    this._props.padding = insets;
    if (!isNull(child)) push(this._children, child);
  }
}

class Center extends Widget {
  constructor(child) {
    super("Center");
    if (!isNull(child)) push(this._children, child);
  }
}

class Align extends Widget {
  constructor(alignment, child) {
    super("Align");
    this._props.alignment = alignment;
    if (!isNull(child)) push(this._children, child);
  }
}

class SizedBox extends Widget {
  constructor(w, h) {
    super("SizedBox");
    if (!isNull(w)) this._props.width = w;
    if (!isNull(h)) this._props.height = h;
  }
}

/// Vertical gap.
class Gap extends SizedBox {
  constructor(h) { super(NIL, h); }
}

class Expanded extends Widget {
  constructor(child) {
    super("Expanded");
    if (!isNull(child)) push(this._children, child);
  }
  flex(f) { this._props.flex = f; return this; }
}

class Flexible extends Widget {
  constructor(child) {
    super("Flexible");
    if (!isNull(child)) push(this._children, child);
  }
  flex(f) { this._props.flex = f; return this; }
}

class Spacer extends Widget {
  constructor() { super("Spacer"); }
  flex(f) { this._props.flex = f; return this; }
}

class Divider extends Widget {
  constructor() { super("Divider"); }
  color(c) { this._props.color = c; return this; }
  thickness(t) { this._props.thickness = t; return this; }
  indent(i) { this._props.indent = i; return this; }
  height(h) { this._props.height = h; return this; }
}

class Opacity extends Widget {
  constructor(value, child) {
    super("Opacity");
    this._props.opacity = value;
    if (!isNull(child)) push(this._children, child);
  }
}

class ClipOval extends Widget {
  constructor(child) {
    super("ClipOval");
    if (!isNull(child)) push(this._children, child);
  }
}

class ClipRRect extends Widget {
  constructor(radius, child) {
    super("ClipRRect");
    this._props.radius = radius;
    if (!isNull(child)) push(this._children, child);
  }
}

class SafeArea extends Widget {
  constructor(child) {
    super("SafeArea");
    if (!isNull(child)) push(this._children, child);
  }
  edges(top, bottom, left, right) {
    this._props.top = top; this._props.bottom = bottom;
    this._props.left = left; this._props.right = right;
    return this;
  }
}

class Wrap extends Widget {
  constructor(list) {
    super("Wrap");
    if (!isNull(list)) this._children = list;
  }
  spacing(s) { this._props.spacing = s; return this; }
  runSpacing(s) { this._props.runSpacing = s; return this; }
}

// ---- Scrolling --------------------------------------------------------------

class ListView extends Widget {
  constructor(list) {
    super("ListView");
    if (!isNull(list)) this._children = list;
  }
  horizontal() { this._props.axis = "horizontal"; return this; }
  pad(insets) { this._props.padding = insets; return this; }
}

class ScrollView extends Widget {
  constructor(child) {
    super("SingleChildScrollView");
    if (!isNull(child)) push(this._children, child);
  }
  horizontal() { this._props.axis = "horizontal"; return this; }
  reverse() { this._props.reverse = true; return this; }
  pad(insets) { this._props.padding = insets; return this; }
}

// ---- Interaction ------------------------------------------------------------

class Button extends Widget {
  constructor(label) {
    super("Button");
    this._props.label = isNull(label) ? "Button" : label;
  }
  onTap(fn) { return this.on("onTap", fn); }
}

class IconButton extends Widget {
  constructor(iconName) {
    super("IconButton");
    this._props.icon = iconName;
  }
  color(c) { this._props.color = c; return this; }
  size(s) { this._props.size = s; return this; }
  onTap(fn) { return this.on("onTap", fn); }
}

class Tappable extends Widget {
  constructor(child) {
    super("GestureDetector");
    if (!isNull(child)) push(this._children, child);
  }
  onTap(fn) { return this.on("onTap", fn); }
  onLongPress(fn) { return this.on("onLongPress", fn); }
  onDoubleTap(fn) { return this.on("onDoubleTap", fn); }
}

class Switcher extends Widget {
  constructor(value) {
    super("Switch");
    this._props.value = isNull(value) ? false : value;
  }
  onChanged(fn) { return this.on("onChanged", fn); }
}

class Field extends Widget {
  constructor() { super("TextField"); }
  value(v) { this._props.value = v; return this; }
  hint(h) { this._props.hint = h; return this; }
  obscure() { this._props.obscure = true; return this; }
  clearOnSubmit() { this._props.clearOnSubmit = true; return this; }
  clearNonce(n) { this._props.clearNonce = n; return this; }
  multiline(min, max) { this._props.minLines = min; this._props.maxLines = max; return this; }
  radius(r) { this._props.radius = r; return this; }
  fill(c) { this._props.fillColor = c; return this; }
  textColor(c) { this._props.textColor = c; return this; }
  hintColor(c) { this._props.hintColor = c; return this; }
  onChanged(fn) { return this.on("onChanged", fn); }
  onSubmitted(fn) { return this.on("onSubmitted", fn); }
}

// ---- Page shell -------------------------------------------------------------

class Scaffold extends Widget {
  constructor() { super("Scaffold"); }
  background(c) { this._props.backgroundColor = c; return this; }
  noKeyboardInset() { this._props.resizeToAvoidBottomInset = false; return this; }
  body(child) { child.prop("slot", "body"); push(this._children, child); return this; }
  bottom(child) { child.prop("slot", "bottom"); push(this._children, child); return this; }
  fab(child) { child.prop("slot", "fab"); push(this._children, child); return this; }
}

// ---- Composite: an avatar (initials or image, with optional online dot) -----

/// A circular avatar showing initials on a seeded colour, or an image. Pass an
/// `onlineColor` to draw the green presence dot.
class Avatar extends Widget {
  constructor(name, diameter) {
    super("Stack");
    this._name = isNull(name) ? "?" : name;
    this._d = isNull(diameter) ? 48.0 : diameter;
    this._imageSrc = NIL;
    this._online = NIL;
    this._bg = NIL;
  }
  image(src) { this._imageSrc = src; return this; }
  online(color) { this._online = color; return this; }
  background(c) { this._bg = c; return this; }

  _initials() {
    let parts = split(trim(this._name), " ");
    let out = "";
    let count = 0;
    for (let i = 0; i < len(parts) && count < 2; i++) {
      let p = parts[i];
      if (len(p) > 0) { out = out + upper(charAt(p, 0)); count = count + 1; }
    }
    if (len(out) === 0) return "?";
    return out;
  }

  toJson(env) {
    let d = this._d;
    let bg = isNull(this._bg) ? ELPA_APP.theme.avatarColor(this._name) : this._bg;
    let circleChild;
    if (!isNull(this._imageSrc)) {
      circleChild = new ClipOval(new Container(new Img(this._imageSrc).fit("cover")).size(d, d));
    } else {
      circleChild = new Container(
        new Center(new Text(this._initials()).color("#FFFFFF").size(d * 0.38).bold())
      ).size(d, d).color(bg).radius(d / 2);
    }
    let layers = [circleChild];
    if (!isNull(this._online)) {
      let dotD = d * 0.28;
      let dot = new Positioned(
        new Container(NIL).size(dotD, dotD).color(this._online).radius(dotD / 2)
      ).at(NIL, NIL, 0.0, 0.0);
      push(layers, dot);
    }
    this._children = layers;
    return super.toJson(env);
  }
}
