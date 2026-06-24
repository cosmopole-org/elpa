// =============================================================================
// Elpa SDK — Widgets
// -----------------------------------------------------------------------------
// An object-oriented, *declarative* wrapper over the Elpa Flutter DSL — authored
// the same way you declare a Flutter widget tree: each widget takes a single
// config object with named props, a `child` / `children`, and inline event
// handlers (`onTap:`, `onChanged:`, ...). Composition is the nesting itself:
//
//   new Container({
//     color: theme.surface,
//     padding: 12,
//     child: new Column({
//       crossAxisAlignment: "start",
//       children: [
//         new Text("Hi", { size: 20, bold: true }),
//         new Button({ label: "Go", onTap: () => doThing() }),
//       ],
//     }),
//   })
//
// `Widget.toJson(env)` is the single serialization seam: it emits `type`, `key`,
// `rev`, `boundary`, `props`, `events` (closures registered into the bus) and the
// recursively-built `children`. Any config key beginning with `on` whose value is
// a function is registered as an event automatically — so `onTap`, `onChanged`,
// `onSubmitted`, `onLongPress`, `onDoubleTap` all "just work" declaratively.
// =============================================================================

/// Base class for every widget. The constructor takes the wire node type and a
/// declarative `config`; subclasses copy their own typed props out of it.
class Widget {
  constructor(nodeType, config) {
    this.nodeType = nodeType;
    this._key = NIL;
    this._rev = NIL;
    this._boundary = false;
    this._props = {};
    this._events = {};
    this._children = [];
    this._apply(config);
  }

  /// Pull the universal fields (key/rev/boundary, child/children, and any inline
  /// `on*` function handlers) out of a config object.
  _apply(config) {
    if (isNull(config)) return;
    if (!isNull(config.key)) this._key = config.key;
    if (!isNull(config.rev)) this._rev = config.rev;
    if (config.boundary === true) this._boundary = true;
    if (!isNull(config.children)) this._children = config.children;
    if (!isNull(config.child)) push(this._children, config.child);
    let ks = keys(config);
    for (let i = 0; i < len(ks); i++) {
      let k = ks[i];
      if (startsWith(k, "on") && typeOf(config[k]) === "function") {
        this._events[k] = config[k];
      }
    }
  }

  /// Copy the named keys from `config` into the wire props (skipping absent ones).
  _take(config, names) {
    if (isNull(config)) return;
    for (let i = 0; i < len(names); i++) {
      let nm = names[i];
      if (!isNull(config[nm])) this._props[nm] = config[nm];
    }
  }

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

/// `new Text("Hi", { size, bold, italic, color, align, oneLine, maxLines })`
class Text extends Widget {
  constructor(content, config) {
    super("Text", config);
    this._props.text = isNull(content) ? "" : str(content);
    if (isNull(config)) return;
    let style = {};
    if (!isNull(config.size)) style.size = config.size;
    if (config.bold === true) style.bold = true;
    if (config.italic === true) style.italic = true;
    if (!isNull(config.color)) style.color = config.color;
    if (len(keys(style)) > 0) this._props.style = style;
    if (!isNull(config.align)) this._props.align = config.align;
    if (config.oneLine === true) { this._props.maxLines = 1; this._props.ellipsis = true; }
    if (!isNull(config.maxLines)) { this._props.maxLines = config.maxLines; this._props.ellipsis = true; }
  }
}

/// `new Icon("send", { size, color })`
class Icon extends Widget {
  constructor(name, config) {
    super("Icon", config);
    this._props.icon = name;
    this._take(config, ["size", "color"]);
  }
}

/// `new Img("https://...", { fit })`
class Img extends Widget {
  constructor(src, config) {
    super("Image", config);
    this._props.src = src;
    this._take(config, ["fit"]);
  }
}

// ---- Layout -----------------------------------------------------------------

/// `new Column({ mainAxisAlignment, crossAxisAlignment, shrink, children })`
class Column extends Widget {
  constructor(config) {
    super("Column", config);
    this._take(config, ["mainAxisAlignment", "crossAxisAlignment"]);
    if (!isNull(config) && config.shrink === true) this._props.shrink = true;
  }
}

/// `new Row({ mainAxisAlignment, crossAxisAlignment, shrink, children })`
class Row extends Widget {
  constructor(config) {
    super("Row", config);
    this._take(config, ["mainAxisAlignment", "crossAxisAlignment"]);
    if (!isNull(config) && config.shrink === true) this._props.shrink = true;
  }
}

/// `new Stack({ alignment, children })`
class Stack extends Widget {
  constructor(config) {
    super("Stack", config);
    this._take(config, ["alignment"]);
  }
}

/// `new Positioned({ left, top, right, bottom, width, height, child })`
class Positioned extends Widget {
  constructor(config) {
    super("Positioned", config);
    this._take(config, ["left", "top", "right", "bottom", "width", "height"]);
  }
}

/// `new Container({ width, height, color, radius, padding, margin, alignment, child })`
class Container extends Widget {
  constructor(config) {
    super("Container", config);
    this._take(config, ["width", "height", "color", "radius", "padding", "margin", "alignment"]);
  }
}

/// `new Padding({ padding, child })`
class Padding extends Widget {
  constructor(config) {
    super("Padding", config);
    this._take(config, ["padding"]);
  }
}

/// `new Center({ child })`
class Center extends Widget {
  constructor(config) {
    super("Center", config);
  }
}

/// `new Align({ alignment, child })`
class Align extends Widget {
  constructor(config) {
    super("Align", config);
    this._take(config, ["alignment"]);
  }
}

/// `new SizedBox({ width, height, child })`
class SizedBox extends Widget {
  constructor(config) {
    super("SizedBox", config);
    this._take(config, ["width", "height"]);
  }
}

/// `new Expanded({ flex, child })`
class Expanded extends Widget {
  constructor(config) {
    super("Expanded", config);
    this._take(config, ["flex"]);
  }
}

/// `new Flexible({ flex, child })` — loose fit, so the child may shrink to content.
class Flexible extends Widget {
  constructor(config) {
    super("Flexible", config);
    this._take(config, ["flex"]);
  }
}

/// `new Spacer({ flex })`
class Spacer extends Widget {
  constructor(config) {
    super("Spacer", config);
    this._take(config, ["flex"]);
  }
}

/// `new Divider({ color, thickness, indent, height })`
class Divider extends Widget {
  constructor(config) {
    super("Divider", config);
    this._take(config, ["color", "thickness", "indent", "height"]);
  }
}

/// `new Opacity({ opacity, child })`
class Opacity extends Widget {
  constructor(config) {
    super("Opacity", config);
    this._take(config, ["opacity"]);
  }
}

/// `new ClipOval({ child })`
class ClipOval extends Widget {
  constructor(config) {
    super("ClipOval", config);
  }
}

/// `new ClipRRect({ radius, child })`
class ClipRRect extends Widget {
  constructor(config) {
    super("ClipRRect", config);
    this._take(config, ["radius"]);
  }
}

/// `new SafeArea({ top, bottom, left, right, child })`
class SafeArea extends Widget {
  constructor(config) {
    super("SafeArea", config);
    this._take(config, ["top", "bottom", "left", "right"]);
  }
}

/// `new Wrap({ spacing, runSpacing, alignment, children })`
class Wrap extends Widget {
  constructor(config) {
    super("Wrap", config);
    this._take(config, ["spacing", "runSpacing", "alignment"]);
  }
}

// ---- Scrolling --------------------------------------------------------------

/// `new ListView({ axis, padding, children })` — `axis: "horizontal"` for a row.
class ListView extends Widget {
  constructor(config) {
    super("ListView", config);
    this._take(config, ["axis", "padding"]);
  }
}

/// `new ScrollView({ axis, reverse, padding, child })`
class ScrollView extends Widget {
  constructor(config) {
    super("SingleChildScrollView", config);
    this._take(config, ["axis", "padding"]);
    if (!isNull(config) && config.reverse === true) this._props.reverse = true;
  }
}

// ---- Interaction ------------------------------------------------------------

/// `new Button({ label, onTap })`
class Button extends Widget {
  constructor(config) {
    super("Button", config);
    this._props.label = (isNull(config) || isNull(config.label)) ? "Button" : config.label;
  }
}

/// `new IconButton({ icon, color, size, onTap })`
class IconButton extends Widget {
  constructor(config) {
    super("IconButton", config);
    this._take(config, ["icon", "color", "size"]);
  }
}

/// `new Tappable({ onTap, onLongPress, onDoubleTap, child })`
class Tappable extends Widget {
  constructor(config) {
    super("GestureDetector", config);
  }
}

/// `new Switcher({ value, onChanged })`
class Switcher extends Widget {
  constructor(config) {
    super("Switch", config);
    this._props.value = (isNull(config) || isNull(config.value)) ? false : config.value;
  }
}

/// `new Field({ value, hint, obscure, clearOnSubmit, clearNonce, minLines,
///             maxLines, radius, fillColor, textColor, hintColor,
///             onChanged, onSubmitted })`
class Field extends Widget {
  constructor(config) {
    super("TextField", config);
    this._take(config, [
      "value", "hint", "minLines", "maxLines", "radius",
      "fillColor", "textColor", "hintColor", "clearNonce",
    ]);
    if (isNull(config)) return;
    if (config.obscure === true) this._props.obscure = true;
    if (config.clearOnSubmit === true) this._props.clearOnSubmit = true;
  }
}

// ---- Page shell -------------------------------------------------------------

/// `new Scaffold({ backgroundColor, resizeToAvoidBottomInset, body, bottom, fab })`
class Scaffold extends Widget {
  constructor(config) {
    super("Scaffold", config);
    this._take(config, ["backgroundColor"]);
    if (isNull(config)) return;
    if (config.resizeToAvoidBottomInset === false) this._props.resizeToAvoidBottomInset = false;
    this._slot(config.body, "body");
    this._slot(config.bottom, "bottom");
    this._slot(config.fab, "fab");
  }
  _slot(widget, name) {
    if (isNull(widget)) return;
    widget._props.slot = name;
    push(this._children, widget);
  }
}

// ---- Composite: an avatar (initials or image, with optional online dot) -----

/// `new Avatar({ name, diameter, online, image, background })` — a circular avatar
/// showing initials on a seeded colour (or an image), with an optional presence dot.
class Avatar extends Widget {
  constructor(config) {
    super("Stack", NIL);
    if (!isNull(config) && !isNull(config.key)) this._key = config.key;
    this._name = (isNull(config) || isNull(config.name)) ? "?" : config.name;
    this._d = (isNull(config) || isNull(config.diameter)) ? 48.0 : config.diameter;
    this._imageSrc = isNull(config) ? NIL : config.image;
    this._online = isNull(config) ? NIL : config.online;
    this._bg = isNull(config) ? NIL : config.background;
  }

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
      circleChild = new ClipOval({
        child: new Container({ width: d, height: d, child: new Img(this._imageSrc, { fit: "cover" }) }),
      });
    } else {
      circleChild = new Container({
        width: d, height: d, color: bg, radius: d / 2,
        child: new Center({
          child: new Text(this._initials(), { color: "#FFFFFF", size: d * 0.38, bold: true }),
        }),
      });
    }
    let layers = [circleChild];
    if (!isNull(this._online)) {
      let dotD = d * 0.28;
      push(layers, new Positioned({
        right: 0.0, bottom: 0.0,
        child: new Container({ width: dotD, height: dotD, color: this._online, radius: dotD / 2 }),
      }));
    }
    this._children = layers;
    return super.toJson(env);
  }
}
