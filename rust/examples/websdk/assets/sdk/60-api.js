// Elpa Web SDK - the public API surface.
//
// The one framework instance `W`, the element constructors apps call (one per
// HTML tag, each building the matching element node), the `h(tag, props,
// children)` hyperscript helper, the component runtime (`defineComponent` /
// `runApp`), the CSS/style helpers, and the host entry points
// (`onEvent`/`onFrame`/`onResize`). Everything here is a thin delegate to `W` and
// the element classes - apps compose a tree of elements + CSS and never touch
// the GPU.

let W = new WebRuntime();

// ---- element factory ---------------------------------------------------------
// Build the right node class for `tag` (special-cased elements, else the generic
// UA-styled HtmlElement).
function mkEl(tag, p) {
    if (isNull(p)) { p = {}; }
    if (tag == "img") { return new ImgElement(tag, p); }
    if (tag == "input") { return new InputElement(tag, p); }
    if (tag == "textarea") { if (!has(p, "style")) { p.style = {}; } return new InputElement(tag, p); }
    if (tag == "a") { return new AnchorElement(tag, p); }
    if (tag == "li") { return new LiElement(tag, p); }
    if (tag == "br") { return new BrElement(tag, p); }
    if (tag == "hr") { return new HrElement(tag, p); }
    return new HtmlElement(tag, p);
}
// Hyperscript: h(tag, props, children). `children` may be an array or a single
// child (string/number/node). Either `props` or `children` may be omitted.
function h(tag, props, children) {
    let p = props; if (isNull(p)) { p = {}; }
    if (typeOf(p) == "array") { children = p; p = {}; }
    if (typeOf(p) == "string") { children = p; p = {}; }
    if (!isNull(children)) { if (typeOf(children) == "array") { p.children = children; } else { p.children = [children]; } }
    return mkEl(tag, p);
}
// A raw text node.
function Text(s) { return new TextRun(concat("", s)); }

// ---- component runtime -------------------------------------------------------
function Component(fn, props) { return new ComponentNode(fn, props); }
function defineComponent(fn) { return (props) => new ComponentNode(fn, props); }
// Mount + paint the first frame. `root` is a component constructor, OR a plain
// element (wrapped in a trivial component) - both work.
function runApp(root) {
    if (typeOf(root) == "object") { W.runApp(() => root); return 0; }
    W.runApp(root); return 0;
}
// Store 1.0/0.0 (not the raw boolean): the runtime gates on `this.layered > 0.5`,
// and the VM rejects ordering comparisons (`>`) between a boolean and a number.
function setLayered(on) { W.layered = 0.0; if (on) { W.layered = 1.0; } }

// ---- animation (the public animation-clock surface) --------------------------
// A continuously-advancing time in ms: reading it inside a component keeps that
// component (and only it) repainting every frame, for looping hero animations.
// Use with sin()/cos() for smooth oscillation. Keep the animated content in its
// own component so the rest of the page stays in the static layered buffer.
function animTime(key) { return W.clock.continuous(key); }
// Ease a scalar toward `target` over ~`durMs` of real time; first read snaps,
// later target changes glide. Returns the current eased value.
function tweenValue(key, target, durMs) { return W.clock.tweenTo(key, target, durMs); }
// The decaying 1->0 press level for a tapped element id (set on pointer-down),
// for press-feedback (a button that dips while held). Reading it animates it.
function pressValue(id) { return W.clock.pressVal(id); }
function setRootFontSize(px) { W.metrics.setRootFontSize(px); if (W.running > 0.5) { W.renderApp(); } }
function viewportWidth() { return W.metrics.cssW(); }
function viewportHeight() { return W.metrics.cssH(); }
function onNavigate(fn) { W.onNavigate = fn; }

// ---- fonts (host atlas, like the other kits) ---------------------------------
function useFont(url) { W.font.applyFont({ url: url }, 1.0); W.refont(); }
function useFontBold(url, boldUrl) { W.font.applyFont({ url: url, boldUrl: boldUrl }, 1.0); W.refont(); }
function useDefaultFont() { W.font.applyFont(0, 0.0); W.refont(); }

// ---- platform services (capability-gated host interfaces) --------------------
function okOf(r) { if (isNull(r)) { return 0.0; } if (has(r, "ok")) { if (r.ok) { return 1.0; } } return 0.0; }
function now() { let r = askHost("time.now", []); if (isNull(r)) { return 0; } if (has(r, "ms")) { return r.ms; } return 0; }
function storeWrite(path, data) { return okOf(askHost("fs.write", [{ path: path, data: data }])); }
function storeRead(path) { let r = askHost("fs.read", [{ path: path }]); if (isNull(r)) { return ""; } if (has(r, "data")) { return r.data; } return ""; }
function httpGet(url, onDone) {
    let r = askHost("net.fetch", [{ method: "GET", url: url }]);
    if (isNull(r)) { onDone(0, ""); return 0; }
    let st = 0; if (has(r, "status")) { st = r.status; }
    let bd = ""; if (has(r, "body")) { bd = r.body; }
    onDone(st, bd); return 0;
}

// ---- element constructors (one per HTML tag) ---------------------------------
// Sectioning / grouping.
function Html(p) { return mkEl("html", p); }
function Body(p) { return mkEl("body", p); }
function Div(p) { return mkEl("div", p); }
function Section(p) { return mkEl("section", p); }
function Article(p) { return mkEl("article", p); }
function Aside(p) { return mkEl("aside", p); }
function Nav(p) { return mkEl("nav", p); }
function Header(p) { return mkEl("header", p); }
function Footer(p) { return mkEl("footer", p); }
function Main(p) { return mkEl("main", p); }
function Figure(p) { return mkEl("figure", p); }
function Figcaption(p) { return mkEl("figcaption", p); }
function Details(p) { return mkEl("details", p); }
function Summary(p) { return mkEl("summary", p); }
function Dialog(p) { return mkEl("dialog", p); }
function Address(p) { return mkEl("address", p); }
// Text blocks.
function P(p) { return mkEl("p", p); }
function H1(p) { return mkEl("h1", p); }
function H2(p) { return mkEl("h2", p); }
function H3(p) { return mkEl("h3", p); }
function H4(p) { return mkEl("h4", p); }
function H5(p) { return mkEl("h5", p); }
function H6(p) { return mkEl("h6", p); }
function Blockquote(p) { return mkEl("blockquote", p); }
function Pre(p) { return mkEl("pre", p); }
function Hr(p) { return mkEl("hr", p); }
function Br(p) { return mkEl("br", p); }
// Lists.
function Ul(p) { return mkEl("ul", p); }
function Ol(p) { return mkEl("ol", p); }
function Li(p) { return mkEl("li", p); }
function Dl(p) { return mkEl("dl", p); }
function Dt(p) { return mkEl("dt", p); }
function Dd(p) { return mkEl("dd", p); }
// Inline.
function Span(p) { return mkEl("span", p); }
function A(p) { return mkEl("a", p); }
function Strong(p) { return mkEl("strong", p); }
function B(p) { return mkEl("b", p); }
function Em(p) { return mkEl("em", p); }
function I(p) { return mkEl("i", p); }
function U(p) { return mkEl("u", p); }
function S(p) { return mkEl("s", p); }
function Small(p) { return mkEl("small", p); }
function Big(p) { return mkEl("big", p); }
function Mark(p) { return mkEl("mark", p); }
function Code(p) { return mkEl("code", p); }
function Kbd(p) { return mkEl("kbd", p); }
function Samp(p) { return mkEl("samp", p); }
function Sub(p) { return mkEl("sub", p); }
function Sup(p) { return mkEl("sup", p); }
function Cite(p) { return mkEl("cite", p); }
function Q(p) { return mkEl("q", p); }
function Abbr(p) { return mkEl("abbr", p); }
function Time(p) { return mkEl("time", p); }
function Dfn(p) { return mkEl("dfn", p); }
function Del(p) { return mkEl("del", p); }
function Ins(p) { return mkEl("ins", p); }
function Label(p) { return mkEl("label", p); }
// Tables.
function Table(p) { return mkEl("table", p); }
function Thead(p) { return mkEl("thead", p); }
function Tbody(p) { return mkEl("tbody", p); }
function Tfoot(p) { return mkEl("tfoot", p); }
function Tr(p) { return mkEl("tr", p); }
function Td(p) { return mkEl("td", p); }
function Th(p) { return mkEl("th", p); }
function Caption(p) { return mkEl("caption", p); }
// Forms.
function Form(p) { return mkEl("form", p); }
function Fieldset(p) { return mkEl("fieldset", p); }
function Legend(p) { return mkEl("legend", p); }
function Input(p) { return mkEl("input", p); }
function TextArea(p) { return mkEl("textarea", p); }
function Button(p) { return mkEl("button", p); }
function Select(p) { return mkEl("select", p); }
function Option(p) { return mkEl("option", p); }
function Optgroup(p) { return mkEl("optgroup", p); }
function Progress(p) { return mkEl("progress", p); }
function Meter(p) { return mkEl("meter", p); }
// Grouping (extra sectioning / list).
function Hgroup(p) { return mkEl("hgroup", p); }
function Menu(p) { return mkEl("menu", p); }
// Embedded.
function Img(p) { return mkEl("img", p); }
function Canvas(p) { return mkEl("canvas", p); }
function Video(p) { return mkEl("video", p); }
function Audio(p) { return mkEl("audio", p); }
function Picture(p) { return mkEl("picture", p); }
function Svg(p) { return mkEl("svg", p); }
function Iframe(p) { return mkEl("iframe", p); }

// ---- host entry points -------------------------------------------------------
function onEvent(e) { W.onEvent(e); }
function onFrame(dt) { W.onFrame(dt); }
function onResize(info) { W.onResize(info); }
