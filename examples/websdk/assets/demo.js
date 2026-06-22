// Elpa Web SDK - showcase page.
//
// A small interactive HTML/CSS document built from the SDK's element
// constructors. It exercises block + inline flow, flexbox, a CSS grid, the box
// model (padding/border/radius/shadow), gradients, an editable text input, a
// list with markers, a button with :hover, and the component runtime's partial
// update (clicking the counter re-runs only the Counter component).

let count = 0;
let name = "";

let Counter = defineComponent(function (props, update) {
    return Div({ style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "12px", marginTop: "12px" }, children: [
        Button({ id: "inc", onClick: () => { count = count + 1; update(); },
            hoverStyle: { background: "#d7d7ff" },
            children: [concat(concat("Clicked ", str(count)), " times")] }),
        Span({ style: { color: "#555" }, children: ["(only this row repaints)"] }),
    ] });
});

let App = defineComponent(function (props, update) {
    // Mobile-first: lay out for a narrow phone by default and only widen when the
    // viewport has room. The runtime re-mounts (re-runs this component) on every
    // resize, so reading `viewportWidth()` here makes the page reflow live.
    let vw = viewportWidth();
    let wide = 0.0; if (vw > 640.0) { wide = 1.0; }
    // On wide screens the two cards sit side-by-side in a flex row with a 2:1
    // width ratio; on a phone they stack as ordinary full-width blocks (a column
    // flex with `flex: 2/1` resolves flex-basis to 0 and would collapse, and
    // block flow wraps the text at the right width anyway).
    let swatchCols = "repeat(3, 1fr)"; if (wide < 0.5) { swatchCols = "1fr"; }
    let pagePad = "16px"; if (wide > 0.5) { pagePad = "24px"; }
    let cardWrap = { marginTop: "20px" };
    let cardA = { background: "white", padding: "16px", borderRadius: "10px", border: "1px solid #e5e7eb", marginBottom: "16px" };
    let cardB = { background: "white", padding: "16px", borderRadius: "10px", border: "1px solid #e5e7eb" };
    if (wide > 0.5) {
        cardWrap = { marginTop: "20px", display: "flex", flexDirection: "row", gap: "16px" };
        cardA = { flex: "2", background: "white", padding: "16px", borderRadius: "10px", border: "1px solid #e5e7eb" };
        cardB = { flex: "1", background: "white", padding: "16px", borderRadius: "10px", border: "1px solid #e5e7eb" };
    }

    return Body({ id: "page", style: { fontFamily: "sans", fontSize: "16px", color: "#1a1a1a", background: "#f6f7fb", padding: pagePad, overflowY: "auto" }, children: [
        // Header card with a linear gradient and a shadow.
        Header({ style: { background: "linear-gradient(90deg, #4f46e5, #06b6d4)", color: "white",
            padding: "20px", borderRadius: "12px", boxShadow: "0 6px 18px rgba(0,0,0,0.18)" }, children: [
            H1({ style: { margin: "0px" }, children: ["Elpa Web SDK"] }),
            P({ style: { margin: "6px 0 0 0", opacity: 0.9 }, children: ["HTML elements + a CSS engine, rendered on the GPU."] }),
        ] }),

        // Two cards: stacked on mobile, two columns when there is room.
        Div({ style: cardWrap, children: [
            Div({ style: cardA, children: [
                H2({ children: ["Flow & inline text"] }),
                P({ children: ["This paragraph wraps across line boxes, with ",
                    Strong({ children: ["bold"] }), ", ", Em({ children: ["italic"] }),
                    " and an ", A({ href: "#", children: ["anchor"] }), " flowing inline like a browser."] }),
                Counter({}),
            ] }),
            Div({ style: cardB, children: [
                H3({ children: ["A list"] }),
                Ul({ children: [
                    Li({ children: ["box model"] }),
                    Li({ children: ["flexbox + grid"] }),
                    Li({ children: ["positioning"] }),
                ] }),
            ] }),
        ] }),

        // CSS grid of swatches (three across when wide, a single column on phones).
        Div({ style: { display: "grid", gridTemplateColumns: swatchCols, gap: "10px", marginTop: "20px" }, children: [
            Div({ style: { height: "60px", borderRadius: "8px", background: "#ef4444" } }),
            Div({ style: { height: "60px", borderRadius: "8px", background: "#10b981" } }),
            Div({ style: { height: "60px", borderRadius: "8px", background: "#3b82f6" } }),
        ] }),

        // A form row; the field grows to fill the width on a phone.
        Div({ style: { marginTop: "20px" }, children: [
            Label({ children: ["Name: "] }),
            Input({ id: "nm", placeholder: "type here", value: name, style: { width: "100%", marginTop: "6px" },
                onInput: (v) => { name = v; W.repaint(); } }),
            P({ children: ["Hello, ", Span({ style: { fontWeight: "bold" }, children: [name] }), "!"] }),
        ] }),
    ] });
});

setLayered(true);
runApp(App);
