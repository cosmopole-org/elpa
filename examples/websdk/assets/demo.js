// Elpa Web SDK — "Elpa" product landing page.
//
// A complete, modern marketing landing page built entirely from the SDK's HTML
// element constructors + CSS — the whole document paints as one instanced SDF
// draw, so it stays high-FPS no matter how many cards/sections it grows. It is
// also a deliberate stress-test of the SDK's newer CSS features:
//
//   * CSS transitions  — nav links, buttons and feature cards glide on :hover
//     (transform / background-color / border-color eased by the animation clock);
//   * a continuous animation — the hero's live "frames-per-second" visualiser
//     oscillates every frame via animTime(), isolated in its own component so
//     ONLY it re-streams each frame (the rest of the page stays in the static
//     layered buffer — that is the high-FPS story, made visible);
//   * text-shadow + letter-spacing on the hero headline and eyebrows;
//   * text-decoration on links; gradients, grid, flexbox, the box model.
//
// Performance notes are inline at each boundary. `setLayered(true)` splits the
// static instances into a buffer the renderer skips re-uploading, leaving only
// the moving component(s) to re-stream — so an animating badge or a hovered card
// costs a few dozen instances per frame, not the whole page.

// ---- small helpers -----------------------------------------------------------
// Note: top-level helper names must not collide with any `let`/param used inside
// the SDK (the VM shares those bindings) — hence `toPx`, not `px` (the runtime's
// event loop has a local `px`), which would clobber this function on first event.
function toPx(n) { return concat(str(n), "px"); }

// ---- palette (kept in one place so the page reads as a designed system) ------
let INK = "#0b1020";          // near-black headings
let MUTE = "#5b6478";         // muted body text
let LINE = "#e7e9f2";         // hairline borders
let BRAND = "#5b5bf0";        // indigo brand
let BRAND2 = "#22d3ee";       // cyan accent
let CARD = "#ffffff";

// =============================================================================
// Live FPS visualiser — its own component so it animates in isolation.
// Reads animTime() (continuous ms) and draws a row of bars whose heights ride a
// sine wave. The element COUNT is constant every frame (only heights/colours
// change), so the dynamic instance stream stays a fixed, tiny size.
// =============================================================================
let FpsBars = defineComponent(function (props, update) {
    let t = animTime("fpsbars");        // continuous time → this component re-paints each frame
    let bars = [];
    let n = 9;
    for (let i = 0; i < n; i++) {
        let phase = num(i) * 0.6;
        let wave = sin(t * 0.004 + phase);          // -1..1
        let h = 14.0 + (wave + 1.0) * 19.0;         // 14..52 px
        let lit = 0.55 + (wave + 1.0) * 0.22;       // brighten the taller bars
        bars = concat(bars, [ Div({ style: {
            width: "8px", height: toPx(floor(h)), borderRadius: "4px",
            background: concat("rgba(34,211,238,", concat(str(round(lit * 100.0) / 100.0), ")")) } }) ]);
    }
    return Div({ style: { display: "flex", flexDirection: "row", alignItems: "flex-end", gap: "6px", height: "54px" },
        children: bars });
});

// A small "1 draw call · 60 FPS" status chip that sits beside the bars.
let LiveChip = defineComponent(function (props, update) {
    let t = animTime("livedot");
    let pulse = 0.5 + (sin(t * 0.005) + 1.0) * 0.25;   // 0.5..1.0 opacity pulse
    return Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }, children: [
        Div({ style: { width: "10px", height: "10px", borderRadius: "5px", background: "#34d399",
            opacity: round(pulse * 100.0) / 100.0 } }),
        Span({ style: { color: "#cbd5ff", fontSize: "13px", letterSpacing: "0.5px" },
            children: ["LIVE · ONE INSTANCED DRAW CALL"] }),
    ] });
});

// =============================================================================
// Nav
// =============================================================================
function navLink(label) {
    return A({ href: "#", id: concat("nav-", label),
        hoverStyle: { color: INK },
        style: { color: MUTE, textDecoration: "none", fontSize: "15px", padding: "8px 4px",
            transition: "color 160ms" },
        children: [label] });
}

let Nav = defineComponent(function (props, update) {
    return Header({ style: { display: "flex", flexDirection: "row", alignItems: "center",
        justifyContent: "space-between", padding: "18px 28px", background: "rgba(255,255,255,0.96)",
        borderBottom: concat("1px solid ", LINE) }, children: [
        // Brand mark.
        Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }, children: [
            Div({ style: { width: "26px", height: "26px", borderRadius: "8px",
                background: "linear-gradient(135deg, #5b5bf0, #22d3ee)" } }),
            Span({ style: { fontWeight: "bold", fontSize: "19px", color: INK, letterSpacing: "0.2px" },
                children: ["Elpa"] }),
        ] }),
        // Links + CTA.
        Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "22px" }, children: [
            navLink("Features"), navLink("Performance"), navLink("Docs"),
            Button({ id: "nav-cta", hoverStyle: { background: "#4848d6", transform: "translateY(-1px)" },
                style: { background: BRAND, color: "white", border: "0px", borderRadius: "10px",
                    padding: "10px 18px", fontSize: "15px", fontWeight: "bold", cursor: "pointer",
                    boxShadow: "0 6px 16px rgba(91,91,240,0.32)", transition: "background-color 160ms, transform 160ms" },
                children: ["Get started"] }),
        ] }),
    ] });
});

// =============================================================================
// Hero — gradient stage, headline with text-shadow, inline email capture, and
// the live FPS visualiser.
// =============================================================================
let email = "";

let Hero = defineComponent(function (props, update) {
    let wide = 0.0; if (viewportWidth() > 820.0) { wide = 1.0; }
    let heroPad = "56px 24px 64px 24px"; if (wide > 0.5) { heroPad = "84px 32px 92px 32px"; }
    return Section({ style: { background: "linear-gradient(160deg, #0b1020 0%, #1b1d4e 55%, #243f8f 100%)",
        padding: heroPad, color: "white" }, children: [
        Div({ style: { maxWidth: "920px", marginLeft: "auto", marginRight: "auto" }, children: [
            // Eyebrow pill (uppercase + letter-spacing).
            Div({ style: { display: "inline-block", background: "rgba(255,255,255,0.10)",
                border: "1px solid rgba(255,255,255,0.18)", borderRadius: "999px", padding: "7px 14px",
                marginBottom: "22px" }, children: [
                Span({ style: { fontSize: "12px", letterSpacing: "1.6px", textTransform: "uppercase",
                    color: "#c7d2fe" }, children: ["GPU-native UI engine"] }) ] }),
            // Headline with a soft text-shadow + tighter tracking.
            H1({ style: { fontSize: "52px", lineHeight: "1.06", margin: "0px", fontWeight: "bold",
                letterSpacing: "-1px", textShadow: "0 8px 30px rgba(34,211,238,0.35)" },
                children: ["Build interfaces that run", Br({}),
                    Span({ style: { color: "#7dd3fc" }, children: ["straight on the GPU."] }) ] }),
            P({ style: { fontSize: "19px", lineHeight: "1.6", color: "#c7cdf0", marginTop: "20px",
                maxWidth: "640px" }, children: [
                "Elpa compiles your JavaScript to a tiny VM and paints the whole document as ",
                Strong({ style: { color: "white" }, children: ["one instanced draw call"] }),
                " — HTML elements, a real CSS engine, and 60 FPS interactions on web, mobile and desktop." ] }),

            // Inline email capture (the interactive form).
            Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "12px",
                marginTop: "30px", maxWidth: "520px", flexWrap: "wrap" }, children: [
                Input({ id: "email", value: email, placeholder: "you@company.com",
                    onInput: (v) => { email = v; W.repaint(); },
                    style: { flex: "1", minWidth: "220px", background: "rgba(255,255,255,0.96)", color: INK,
                        border: "0px", borderRadius: "12px", padding: "14px 16px", fontSize: "16px" } }),
                Button({ id: "cta", hoverStyle: { background: "#06b6d4", transform: "translateY(-2px) scale(1.02)" },
                    style: { background: BRAND2, color: "#062a33", border: "0px", borderRadius: "12px",
                        padding: "14px 22px", fontSize: "16px", fontWeight: "bold", cursor: "pointer",
                        boxShadow: "0 10px 24px rgba(34,211,238,0.35)",
                        transition: "background-color 200ms, transform 200ms" },
                    children: ["Start free"] }),
            ] }),
            P({ style: { fontSize: "13px", color: "#8b93c4", marginTop: "12px" },
                children: ["No credit card required. Ships to web, iOS, Android and desktop from one codebase."] }),

            // Live, isolated animation — the high-FPS proof.
            Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "22px",
                marginTop: "44px", padding: "20px 22px", background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.10)", borderRadius: "16px", flexWrap: "wrap" }, children: [
                FpsBars({}),
                Div({ style: { display: "flex", flexDirection: "column", gap: "8px" }, children: [
                    LiveChip({}),
                    Span({ style: { fontSize: "13px", color: "#8b93c4" },
                        children: ["These bars repaint every frame; the page around them does not."] }),
                ] }),
            ] }),
        ] }),
    ] });
});

// =============================================================================
// Trust strip
// =============================================================================
let Trust = defineComponent(function (props, update) {
    let names = ["NORTHWIND", "ACME", "HELIOS", "VERTEX", "LUMEN", "QUANTA"];
    let items = [];
    for (let i = 0; i < len(names); i++) {
        items = concat(items, [ Span({ style: { color: "#9aa1b8", fontSize: "15px", fontWeight: "bold",
            letterSpacing: "2px" }, children: [names[i]] }) ]);
    }
    return Div({ style: { background: "#f7f8fc", padding: "26px 24px", borderBottom: concat("1px solid ", LINE) },
        children: [
            P({ style: { textAlign: "center", color: "#9aa1b8", fontSize: "12px", letterSpacing: "1.5px",
                textTransform: "uppercase", margin: "0 0 18px 0" }, children: ["Trusted by product teams"] }),
            Div({ style: { display: "flex", flexDirection: "row", justifyContent: "center",
                alignItems: "center", gap: "40px", flexWrap: "wrap" }, children: items }),
        ] });
});

// =============================================================================
// Feature cards — each its own component, so a :hover lift re-runs only that
// card and the eased transform/colours re-stream in the tiny dynamic buffer.
// =============================================================================
let FeatureCard = defineComponent(function (props, update) {
    let p = props;
    return Div({ id: p.cid,
        hoverStyle: { transform: "translateY(-8px)", background: "#fbfbff", borderColor: BRAND },
        style: { background: CARD, border: concat("1px solid ", LINE), borderRadius: "18px", padding: "26px",
            boxShadow: "0 10px 30px rgba(17,24,39,0.06)",
            transition: "transform 240ms, background-color 240ms, border-color 240ms" }, children: [
        Div({ style: { width: "44px", height: "44px", borderRadius: "12px", background: p.grad,
            marginBottom: "18px" } }),
        H3({ style: { fontSize: "19px", color: INK, margin: "0 0 8px 0" }, children: [p.title] }),
        P({ style: { fontSize: "15px", lineHeight: "1.6", color: MUTE, margin: "0px" }, children: [p.body] }),
    ] });
});

let Features = defineComponent(function (props, update) {
    let cols = "1fr"; let w = viewportWidth();
    if (w > 1040.0) { cols = "repeat(3, 1fr)"; } else { if (w > 680.0) { cols = "repeat(2, 1fr)"; } }
    let data = [
        { cid: "f1", grad: "linear-gradient(135deg, #5b5bf0, #8b5cf6)", title: "One draw call",
          body: "The entire document — text, boxes, borders, gradients, shadows — paints through a single instanced SDF pipeline." },
        { cid: "f2", grad: "linear-gradient(135deg, #22d3ee, #3b82f6)", title: "Real CSS engine",
          body: "The box model, flow, flexbox, grid, positioning, the <color>/<length> grammar, transitions and transforms." },
        { cid: "f3", grad: "linear-gradient(135deg, #f59e0b, #ef4444)", title: "Partial re-render",
          body: "Components re-run in isolation; only what changed re-streams. Hover a card — just that card repaints." },
        { cid: "f4", grad: "linear-gradient(135deg, #10b981, #22d3ee)", title: "Write JavaScript",
          body: "Compose a tree of HTML elements styled with CSS. The kit lays it out and paints it — you never touch the GPU." },
        { cid: "f5", grad: "linear-gradient(135deg, #ec4899, #8b5cf6)", title: "One codebase",
          body: "The same program runs on web, iOS, Android and desktop, driving wgpu directly on every target." },
        { cid: "f6", grad: "linear-gradient(135deg, #6366f1, #06b6d4)", title: "High FPS by design",
          body: "A static / dynamic split keeps unchanging instances in a buffer the renderer never re-uploads." },
    ];
    let cards = [];
    for (let i = 0; i < len(data); i++) { cards = concat(cards, [ FeatureCard(data[i]) ]); }
    return Section({ style: { padding: "84px 24px", background: "white" }, children: [
        Div({ style: { maxWidth: "1100px", marginLeft: "auto", marginRight: "auto" }, children: [
            P({ style: { textAlign: "center", color: BRAND, fontSize: "13px", letterSpacing: "1.5px",
                textTransform: "uppercase", fontWeight: "bold", margin: "0px" }, children: ["Why Elpa"] }),
            H2({ style: { textAlign: "center", fontSize: "38px", color: INK, margin: "10px 0 12px 0",
                letterSpacing: "-0.5px" }, children: ["Everything the browser does — on the GPU."] }),
            P({ style: { textAlign: "center", fontSize: "18px", color: MUTE, maxWidth: "620px",
                marginLeft: "auto", marginRight: "auto", marginTop: "0px", marginBottom: "48px",
                lineHeight: "1.6" }, children: ["A complete element model and CSS system, engineered to stay fast while things move."] }),
            Div({ style: { display: "grid", gridTemplateColumns: cols, gap: "22px" }, children: cards }),
        ] }),
    ] });
});

// =============================================================================
// Performance band — big animated stats.
// =============================================================================
let StatBand = defineComponent(function (props, update) {
    let stats = [
        { n: "1", l: "instanced draw call for the whole page" },
        { n: "4", l: "platforms from a single codebase" },
        { n: "60", l: "frames per second while you interact" },
    ];
    let cells = [];
    for (let i = 0; i < len(stats); i++) {
        cells = concat(cells, [ Div({ style: { textAlign: "center" }, children: [
            Div({ style: { fontSize: "54px", fontWeight: "bold", color: "white", letterSpacing: "-1px",
                textShadow: "0 6px 24px rgba(34,211,238,0.45)" }, children: [stats[i].n] }),
            P({ style: { color: "#aeb6e0", fontSize: "15px", marginTop: "6px", lineHeight: "1.5" },
                children: [stats[i].l] }),
        ] }) ]);
    }
    let cols = "1fr"; if (viewportWidth() > 720.0) { cols = "repeat(3, 1fr)"; }
    return Section({ style: { background: "linear-gradient(120deg, #11163a, #2a2f73)", padding: "72px 24px" },
        children: [
            Div({ style: { maxWidth: "1000px", marginLeft: "auto", marginRight: "auto", display: "grid",
                gridTemplateColumns: cols, gap: "36px", alignItems: "center" }, children: cells }),
        ] });
});

// =============================================================================
// FAQ — click to expand (module state + full repaint on toggle).
// =============================================================================
let openIdx = -1;

let FaqItem = defineComponent(function (props, update) {
    let p = props; let open = 0.0; if (openIdx == p.idx) { open = 1.0; }
    let mark = "+"; if (open > 0.5) { mark = "–"; }
    let kids = [ Div({ id: concat("faq-", str(p.idx)),
        onClick: () => { if (openIdx == p.idx) { openIdx = -1; } else { openIdx = p.idx; } W.repaint(); },
        hoverStyle: { background: "#f7f8fc" },
        style: { display: "flex", flexDirection: "row", justifyContent: "space-between",
            alignItems: "center", padding: "20px 6px", cursor: "pointer", transition: "background-color 140ms" },
        children: [
            Span({ style: { fontSize: "17px", fontWeight: "bold", color: INK }, children: [p.q] }),
            Span({ style: { fontSize: "22px", color: BRAND }, children: [mark] }),
        ] }) ];
    if (open > 0.5) {
        kids = concat(kids, [ P({ style: { fontSize: "15px", lineHeight: "1.6", color: MUTE,
            margin: "0 0 18px 0", maxWidth: "720px" }, children: [p.a] }) ]);
    }
    return Div({ style: { borderBottom: concat("1px solid ", LINE) }, children: kids });
});

let Faq = defineComponent(function (props, update) {
    let qs = [
        { idx: 0, q: "Is this a DOM or a widget toolkit?", a: "Neither. Elpa sits at wgpu's level and paints HTML/CSS itself through one SDF pipeline — there is no DOM and no platform widgets underneath." },
        { idx: 1, q: "How does it stay at 60 FPS?", a: "Components re-render in isolation and a static/dynamic split keeps unchanging instances in a buffer the renderer never re-uploads — only moving elements re-stream." },
        { idx: 2, q: "Which CSS does it support?", a: "The box model, block/inline flow, flexbox, grid, positioning, the full color and length grammar, gradients, shadows, transforms, transitions, text-decoration and letter-spacing." },
        { idx: 3, q: "What do I write?", a: "Plain JavaScript: compose a tree of element constructors styled with CSS objects. The same program runs on web, mobile and desktop." },
    ];
    let items = [];
    for (let i = 0; i < len(qs); i++) { items = concat(items, [ FaqItem(qs[i]) ]); }
    return Section({ style: { background: "white", padding: "84px 24px" }, children: [
        Div({ style: { maxWidth: "780px", marginLeft: "auto", marginRight: "auto" }, children: concat([
            H2({ style: { fontSize: "34px", color: INK, textAlign: "center", margin: "0 0 36px 0",
                letterSpacing: "-0.5px" }, children: ["Questions, answered"] }),
        ], items) }),
    ] });
});

// =============================================================================
// Closing CTA + footer
// =============================================================================
let Closing = defineComponent(function (props, update) {
    return Section({ style: { padding: "10px 24px 80px 24px", background: "white" }, children: [
        Div({ style: { maxWidth: "980px", marginLeft: "auto", marginRight: "auto",
            background: "linear-gradient(135deg, #5b5bf0, #06b6d4)", borderRadius: "26px",
            padding: "56px 32px", textAlign: "center", boxShadow: "0 24px 60px rgba(91,91,240,0.30)" }, children: [
            H2({ style: { color: "white", fontSize: "36px", margin: "0px", letterSpacing: "-0.5px",
                textShadow: "0 6px 22px rgba(0,0,0,0.18)" }, children: ["Ship your first GPU-native page today."] }),
            P({ style: { color: "#eaf6ff", fontSize: "18px", marginTop: "14px", marginBottom: "28px" },
                children: ["From idea to 60 FPS on four platforms — without leaving JavaScript."] }),
            Button({ id: "cta2", hoverStyle: { background: "#0b1020", transform: "translateY(-2px) scale(1.03)" },
                style: { background: INK, color: "white", border: "0px", borderRadius: "14px",
                    padding: "16px 32px", fontSize: "17px", fontWeight: "bold", cursor: "pointer",
                    boxShadow: "0 12px 28px rgba(0,0,0,0.28)", transition: "background-color 200ms, transform 200ms" },
                children: ["Get started — it's free"] }),
        ] }),
    ] });
});

function footLink(label) {
    return A({ href: "#", hoverStyle: { color: INK },
        style: { display: "block", color: MUTE, fontSize: "14px", padding: "5px 0px",
            textDecoration: "none", transition: "color 140ms" }, children: [label] });
}

let Footer2 = defineComponent(function (props, update) {
    let cols = "1fr"; if (viewportWidth() > 720.0) { cols = "2fr 1fr 1fr 1fr"; }
    return Footer({ style: { background: "#0b1020", padding: "56px 24px 40px 24px", color: "#cbd2f5" },
        children: [
            Div({ style: { maxWidth: "1100px", marginLeft: "auto", marginRight: "auto", display: "grid",
                gridTemplateColumns: cols, gap: "32px" }, children: [
                Div({ children: [
                    Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px",
                        marginBottom: "12px" }, children: [
                        Div({ style: { width: "24px", height: "24px", borderRadius: "7px",
                            background: "linear-gradient(135deg, #5b5bf0, #22d3ee)" } }),
                        Span({ style: { fontWeight: "bold", fontSize: "18px", color: "white" }, children: ["Elpa"] }),
                    ] }),
                    P({ style: { fontSize: "14px", color: "#8b93c4", lineHeight: "1.6", maxWidth: "280px" },
                        children: ["A programmable VM around the wgpu API. Write JavaScript; render on the GPU."] }),
                ] }),
                Div({ children: [ H4({ style: { color: "white", fontSize: "14px", margin: "0 0 6px 0",
                    letterSpacing: "0.5px" }, children: ["Product"] }), footLink("Features"), footLink("Performance"), footLink("Pricing") ] }),
                Div({ children: [ H4({ style: { color: "white", fontSize: "14px", margin: "0 0 6px 0",
                    letterSpacing: "0.5px" }, children: ["Developers"] }), footLink("Docs"), footLink("Examples"), footLink("GitHub") ] }),
                Div({ children: [ H4({ style: { color: "white", fontSize: "14px", margin: "0 0 6px 0",
                    letterSpacing: "0.5px" }, children: ["Company"] }), footLink("About"), footLink("Blog"), footLink("Contact") ] }),
            ] }),
            Div({ style: { maxWidth: "1100px", marginLeft: "auto", marginRight: "auto", marginTop: "40px",
                paddingTop: "22px", borderTop: "1px solid rgba(255,255,255,0.10)" }, children: [
                Span({ style: { fontSize: "13px", color: "#6b739c" },
                    children: ["© 2026 Elpa. Rendered entirely on the GPU as one instanced draw."] }),
            ] }),
        ] });
});

// =============================================================================
// Page assembly. The body is the scroll container (overflow:auto). The whole
// document is laid out and painted as one instanced SDF draw; only the
// continuously-animating components (the FPS bars / live chip) and any hovered
// card re-stream each frame, so interaction stays smooth.
// =============================================================================
let App = defineComponent(function (props, update) {
    return Body({ id: "page", style: { fontFamily: "sans", color: INK, background: "white",
        overflowY: "auto" }, children: [
        Nav({}), Hero({}), Trust({}), Features({}), StatBand({}), Faq({}), Closing({}), Footer2({}),
    ] });
});

setLayered(true);
runApp(App);
