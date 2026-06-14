// Elpa Material Design 3 demo — the application, in JavaScript.
//
// This is what the GitHub Pages deployment runs. It uses the Material SDK
// (linked ahead of this file, like `import 'package:flutter/material.dart'`) as a
// pure black box: it declares state, composes a widget tree from the SDK's
// widgets, and hands it to `runApp`. There is no `gpu.submit`, no glyph data, no
// coordinates, and no event plumbing here — the SDK owns all of that. A tap
// handler just mutates state and calls `update()` to repaint, exactly like
// `setState` in Flutter.

// --- application state --------------------------------------------------------
let dark = 0.0;   // 0 light, 1 dark
let accent = 0;   // accent palette index (cycled by the FAB)
let swOn = 0.0; let ck = 0.0; let chip = 0.0; let radio = 0; let vol = 0.5;

// --- custom widgets, composed from material widgets via createComponent --------
// A caption stacked above a control. A static custom component (it ignores
// `update`) — the Flutter pattern of building your own widget from others.
function Tile(label, control) {
    return createComponent((update) => Column({ gap: 1.3, children: [
        Text(label, { size: "caption" }),
        control,
    ] }));
}

// A row of three radios with captions. A *stateful* custom component: each
// radio's tap closure captures its own `idx` and calls this component's
// `update` to repaint.
function RadioRow() {
    return createComponent((update) => {
        let names = ["A", "B", "C"];
        let kids = [];
        for (let i = 0; i < 3; i++) {
            let idx = i;
            push(kids, Tile(names[idx], Radio({
                id: concat("r", str(idx)),
                selected: sel(radio, idx),
                onTap: () => { radio = idx; update(); },
            })));
        }
        return Row({ gap: 5.0, children: kids });
    });
}

// --- the app ------------------------------------------------------------------
let app = createComponent((update) => {
    setTheme(dark, accent);   // push app theme into the framework each build
    return Scaffold({
        onKey: (k) => {
            if (k == "d") { dark = 1.0 - dark; }
            if (k == " ") { swOn = 1.0 - swOn; }
            if (k == "r") { swOn = 0.0; ck = 0.0; chip = 0.0; radio = 0; vol = 0.5; }
            if (k == "ArrowRight") { vol = clamp01(vol + 0.05); }
            if (k == "ArrowLeft") { vol = clamp01(vol - 0.05); }
            update();
        },
        appBar: AppBar({ title: "ELPA UI" }),
        fab: Fab({ onTap: () => { accent = (accent + 1) % 4; update(); } }),
        body: Card({ child: Column({ gap: 3.0, children: [
            Row({ gap: 4.0, children: [
                FilledButton({ label: "THEME", onTap: () => { dark = 1.0 - dark; update(); } }),
                OutlinedButton({ label: "RESET", onTap: () => {
                    swOn = 0.0; ck = 0.0; chip = 0.0; radio = 0; vol = 0.5; update();
                } }),
            ] }),
            Row({ gap: 7.0, children: [
                Tile("WI-FI", Switch({ id: "wifi", value: swOn, onTap: () => { swOn = 1.0 - swOn; update(); } })),
                Tile("AGREE", Checkbox({ id: "agree", value: ck, onTap: () => { ck = 1.0 - ck; update(); } })),
            ] }),
            Tile("VOLUME", Slider({ value: vol, onChanged: (v) => { vol = v; update(); } })),
            Tile("FILTER", Chip({ id: "filter", label: "FILTER", value: chip,
                onTap: () => { chip = 1.0 - chip; update(); } })),
            RadioRow(),
            Divider({}),
            Tile("TASKS", Progress({ id: "tasks", value: (swOn + ck + chip) / 3.0 })),
        ] }) }),
    });
});

runApp(app);
