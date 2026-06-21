# Elpa Web SDK (HTML + CSS)

An **HTML element model + a CSS engine** for Elpa — the browser's rendering
layer — written as **JavaScript**, not Rust. Elpa compiles the JS to its VM and
runs it directly. Apps compose a tree of HTML elements styled with CSS and never
touch the GPU; the kit lays the page out (box model, flow, flexbox, grid,
positioning) and paints the **entire document through one instanced SDF
pipeline** (text, boxes, borders, gradients, shadows), so it stays high-FPS
regardless of element count.

It is built with the **same object-oriented, class-component pattern** as the
Material and Liquid-Glass kits in this repo: each HTML tag is a class
(`Box` subclass); apps instantiate them with constructors (`Div`, `P`, `Button`,
…) and a `defineComponent` / `runApp` runtime gives React/Flutter-style
components with **partial re-render**.

## Writing a page

```js
let count = 0;

let Counter = defineComponent(function (props, update) {
    return Button({ onClick: () => { count = count + 1; update(); },
        hoverStyle: { background: "#d7d7ff" },
        children: [concat("Clicked ", concat(str(count), " times"))] });
});

let App = defineComponent(function (props, update) {
    return Body({ style: { fontFamily: "sans", padding: "24px", background: "#f6f7fb" }, children: [
        H1({ children: ["Hello, Elpa Web"] }),
        Div({ style: { display: "flex", gap: "16px" }, children: [
            Div({ style: { flex: "2", background: "white", padding: "16px", borderRadius: "10px" },
                  children: ["A two-column ", Strong({ children: ["flex"] }), " layout."] }),
            Div({ style: { flex: "1", background: "white", padding: "16px", borderRadius: "10px" },
                  children: [ Counter({}) ] }),
        ] }),
    ] });
});

runApp(App);
```

* **Elements are class components.** `Div`, `Span`, `P`, `H1`–`H6`, `A`, `Img`,
  `Ul`/`Ol`/`Li`, `Table`/`Tr`/`Td`, `Button`, `Input`, `Form`, … each build a
  `Box` subclass. A raw string/number child becomes a text node.
* **Style is CSS.** The `style` prop is a CSS declaration object (camelCase or
  kebab-case keys); values are CSS strings (`"16px"`, `"#f6f7fb"`,
  `"linear-gradient(90deg, #4f46e5, #06b6d4)"`) or numbers.
* **`update()` repaints only its component** — the runtime re-runs just that
  component's function and reassembles the frame from every other component's
  cached output. `setLayered(true)` additionally keeps the static instances in a
  buffer the renderer skips re-uploading.
* **`h(tag, props, children)`** is a hyperscript escape hatch for any tag.

## Module layout (`assets/sdk/`, concatenated in dependency order)

| Module | Responsibility |
|--------|----------------|
| `00-data` | The SDF + image WGSL shaders, the fallback glyph font, the **CSS named-colour table** (CSS Color L4 keywords) and shared constants. |
| `10-engine` | `Painter` (the 16-float instanced primitive: rect/shadow/glyph/gradient/image), `FontEngine` (host glyph atlas + stroke fallback), `MediaEngine` (images), `AnimationClock` (eased values + per-key subscriber tracking for partial animation). |
| `15-css` | **The CSS engine**: the `Viewport`, the `<color>` grammar (keywords, `#rgb/#rgba/#rrggbb/#rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`, `transparent`, `currentColor`), the `<length>`/`<percentage>` grammar (`px`, `em`, `rem`, `vw/vh/vmin/vmax`, `%`, `pt`, `auto`/`none`), shorthand expansion (margin/padding/border/radius/inset/gap/flex/background/box-shadow/transform/transition), inheritance, and the `computeStyle` cascade. |
| `20-node` | The `Box` base class — the CSS box model (content/padding/border/margin, `box-sizing`, min/max clamping) and the painted decoration (background colour & gradient, per-side borders, border-radius, box-shadow, outline) wrapped in the `transform`/`opacity` group. |
| `30-layout` | The layout algorithms — **block + inline flow** (line-box text wrapping, `text-align`), **flexbox** (direction/wrap/grow/shrink/basis/justify/align/order/gap), **grid** (`grid-template-columns/rows` with `px`/`%`/`fr`/`repeat()`, gaps), and **positioning** (relative/absolute/fixed). |
| `40-elements` | The HTML element catalog as `Box` subclasses + the **user-agent stylesheet** (every tag's default `display`, margins, font size/weight). Behavioural elements: `<img>`, `<input>`/`<textarea>` (focus + caret + key editing), `<a>`, `<li>` (markers), `<br>`, `<hr>`. |
| `50-runtime` | The retained-tree `WebRuntime`: mount, **partial update**, the transition/animation clock, the DOM-style **event loop** (click, hover/`:hover`, focus, keyboard, scroll/`overflow`), and the `gpu.submit` frame builder with the **static/dynamic layered** split. |
| `60-api` | The element constructors, `h()`, `defineComponent`/`runApp`, the style/viewport helpers, and the host entry points (`onEvent`/`onFrame`/`onResize`). |

## CSS coverage

* **Box model** — `width`/`height`/`min`/`max`, `box-sizing`, `margin`
  (incl. auto-centring), `padding`, per-side `border` (width/style/colour),
  per-corner `border-radius`, `box-shadow` (drop), `outline`, `opacity`,
  `visibility`, `overflow`(-x/y) scrolling with momentum.
* **Layout** — `display: block | inline | inline-block | flex | inline-flex |
  grid | none`; normal flow with inline line-box text wrapping; the full
  flexbox model; a CSS grid; `position: static | relative | absolute | fixed`
  with `top/right/bottom/left`; `z-index`.
* **Typography** — `color`, `font-size` (px/em/rem/%), `font-weight`,
  `font-style`, `line-height`, `letter-spacing`, `text-align`,
  `text-transform`, `white-space`, with CSS inheritance.
* **Paint** — solid + `linear`/`radial`/`conic` gradient backgrounds,
  `transform` (`translate`/`scale`/`rotate`), `transition` (driven by the
  animation clock).

> **Single-pass by design.** Like the Material kit, the whole document is one
> instanced rounded-rect SDF draw — text is sampled from a coverage atlas in the
> same shader. The SDF primitive carries a single corner radius, so the four CSS
> corners are averaged (equal corners — the common case — are exact); per-side
> borders that differ are drawn as separate edge rects.

## Build & test

```bash
cargo test  -p elpa-websdk            # headless end-to-end (mount, layout, paint, events)
cargo run   -p elpa-websdk --bin build_bytecode   # lower the program to assets/demo.bc
```

`tests/run.rs` drives the SDK + showcase page on a real (headless) `Elpa`
instance: it validates the WGSL with `naga`, mounts and paints the document as
one instanced SDF draw, and flows pointer/keyboard events through the SDK.

## Notes on the JavaScript subset

Elpa's in-VM front-end supports a subset of JavaScript. This kit stays inside it
and, in particular, **avoids** constructs the VM does not implement, which were
established empirically while building it: `&&`/`||`/ternary (use nested `if`),
`continue` (use guarded `if`/`else`), `super.method()` (use a `this.baseX()`
delegate + the `premount` hook), and static class methods (use top-level
functions). `typeOf` reports every numeric representation (i16…f64) as
`"number"`, so numeric checks go through the `isNum` helper. Implicit constructors do
not forward arguments, so every `Box` subclass declares
`constructor(tag, props) { super(tag, props); }`.
