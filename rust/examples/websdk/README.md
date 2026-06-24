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
| `10-engine` | `Painter` (the 16-float instanced primitive: rect/shadow/glyph/gradient/image, plus `skew`), `FontEngine` (host glyph atlas + stroke fallback, **letter-spacing aware**), `MediaEngine` (images), `AnimationClock` (eased values, **real-time CSS-transition tweens**, a **continuous time source**, and per-key subscriber tracking so the frame clock repaints only what is moving). |
| `15-css` | **The CSS engine**: the `Viewport`, the `<color>` grammar (keywords, `#rgb/#rgba/#rrggbb/#rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`, `transparent`, `currentColor`), the `<length>`/`<percentage>` grammar (`px`, `em`, `rem`, `vw/vh/vmin/vmax`, `%`, `pt`, `auto`/`none`), shorthand expansion (margin/padding/border/radius/inset/gap/flex/background/box-shadow/transform/transition), inheritance, and the `computeStyle` cascade. |
| `20-node` | The `Box` base class — the CSS box model (content/padding/border/margin, `box-sizing`, min/max clamping) and the painted decoration (background colour & gradient, per-side borders, border-radius, box-shadow, outline) wrapped in the `transform`/`opacity` group. |
| `30-layout` | The layout algorithms — **block + inline flow** (line-box text wrapping, `text-align`), **flexbox** (direction/grow/shrink/basis/justify/align/order/gap **plus multi-line `flex-wrap` + `align-content`**), **grid** (`grid-template-columns/rows` with `px`/`%`/`fr`/`repeat()`, gaps), and **positioning** (relative/absolute/fixed). |
| `40-elements` | The HTML element catalog as `Box` subclasses + the **user-agent stylesheet** (every tag's default `display`, margins, font size/weight). Behavioural elements: `<img>`, `<input>`/`<textarea>` (focus + caret + key editing), `<a>`, `<li>` (markers), `<br>`, `<hr>`. |
| `50-runtime` | The retained-tree `WebRuntime`: mount, **partial update**, the transition/animation clock, the DOM-style **event loop** (click, hover/`:hover`, focus, keyboard, scroll/`overflow`), and the `gpu.submit` frame builder with the **static/dynamic layered** split and the **two-pass `backdrop-filter` compositor** (offscreen scene capture → multi-tap blur composite). |
| `60-api` | The element constructors (one per HTML tag), `h()`, `defineComponent`/`runApp`, the style/viewport helpers, the animation surface (`animTime`/`tweenValue`/`pressValue`), and the host entry points (`onEvent`/`onFrame`/`onResize`). |

## CSS coverage

* **Box model** — `width`/`height`/`min`/`max`, `box-sizing`, `margin`
  (incl. auto-centring), `padding`, per-side `border` (width/style/colour),
  per-corner `border-radius`, `box-shadow` (drop), `outline`, `opacity`,
  `visibility`, `overflow`(-x/y) scrolling with momentum.
* **Layout** — `display: block | inline | inline-block | flex | inline-flex |
  grid | none`; normal flow with inline line-box text wrapping; the full
  flexbox model **including multi-line `flex-wrap`** (`wrap` / `wrap-reverse`,
  with per-line grow/shrink/justify and `align-content` distribution); a CSS
  grid; `position: static | relative | absolute | fixed` with
  `top/right/bottom/left`; `z-index`.
* **Typography** — `color`, `font-size` (px/em/rem/%), `font-weight`,
  `font-style`, `line-height`, **`letter-spacing`** (applied to text measure &
  paint), `text-align`, `text-transform`, `white-space`, **`text-decoration`**
  (`underline` / `overline` / `line-through`, painted as a rule across the run),
  **`text-shadow`** (offset copies behind the glyphs), with CSS inheritance.
* **Paint** — solid + `linear`/`radial`/`conic` gradient backgrounds,
  `transform` (`translate`/`scale`/`rotate`/`skew`), and **`backdrop-filter:
  blur()`** — a real frosted-glass effect: the content behind the box is
  captured to a reduced-resolution offscreen target, blurred (multi-tap), and
  composited back under the box's translucent background in a two-pass frame.
* **Transitions & animation** — `transition` is wired to the animation clock:
  a state change (e.g. `:hover`) **eases** `opacity`, `transform`,
  `background-color`, `border-color` **and gradient backgrounds** (a
  `transition: background` cross-fades the gradient's stop colours and axis)
  over the declared duration instead of snapping. Apps can also drive their own
  motion: `animTime(key)` (a continuous ms time that keeps just the reading
  component repainting — for looping hero animations), `tweenValue(key, target,
  ms)` (an eased scalar) and `pressValue(id)` (a decaying press level for tap
  feedback).

> **Single-pass by design.** Like the Material kit, the whole document is one
> instanced rounded-rect SDF draw — text is sampled from a coverage atlas in the
> same shader. The SDF primitive carries a single corner radius, so the four CSS
> corners are averaged (equal corners — the common case — are exact); per-side
> borders that differ are drawn as separate edge rects. The two exceptions that
> add passes are `<img>`/video (interleaved textured quads) and `backdrop-filter`
> (an offscreen capture + blur composite); a frame that uses neither stays a
> single instanced draw, and the **static/dynamic layered** split keeps an
> animating component's per-frame cost to just its own instances.

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
`constructor(tag, props) { super(tag, props); }`. `has(obj, key)` tests only an
object's **own data fields**, not its class methods, so type predicates flag a
node with an own field (e.g. `TextRun` sets `this._isText`) rather than probing
for a method name. Ordering comparisons (`<`/`>`) trap on a boolean operand, so
flags stored for such comparisons are kept as `1.0`/`0.0` numbers, not `true`/
`false`. Finally, **top-level names share one binding space with the SDK's
function-locals** — an app's global helper must not reuse a name the SDK uses as
a local (e.g. the runtime's event loop has a local `px`, so the demo's
px-formatter is named `toPx`), or the local will clobber it on first use.
