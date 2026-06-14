// Elpa Material Design 3 demo — the application, in JavaScript.
//
// This is what the GitHub Pages deployment runs. It uses the Material SDK
// (linked ahead of this file, like `import 'package:flutter/material.dart'`) as a
// pure black box: it declares state and composes a widget tree from the SDK's
// widgets. There is no `gpu.submit`, no glyph data, no coordinates, and no event
// plumbing here — the SDK owns all of that.
//
// Components are plain functions, React-style: a custom widget is just a function
// that returns a widget tree, taking `update` if it has interactivity. A tap
// handler mutates state and calls `update()` to repaint (the Flutter `setState`
// pattern). `runApp` mounts the root component and re-invokes it every render, so
// these functions re-run and rebuild the tree from current state.

// --- application state --------------------------------------------------------
let dark = 0.0;   // 0 light, 1 dark
let accent = 0;   // accent palette index (cycled by the FAB)
let swOn = 0.0; let ck = 0.0; let chip = 0.0; let radio = 0; let vol = 0.5;

// --- custom widgets: ordinary functions returning a widget tree ---------------
// A caption stacked above a control. No interactivity, so no `update`.
function Tile(label, control) {
    return Column({ gap: 1.3, children: [
        Text(label, { size: "caption" }),
        control,
    ] });
}

// A row of three radios with captions. Interactive, so it takes `update`; each
// radio's tap closure captures its own `idx`.
function RadioRow(update) {
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
}

// --- the root component -------------------------------------------------------
function App(update) {
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
            RadioRow(update),
            Divider({}),
            Tile("TASKS", Progress({ id: "tasks", value: (swOn + ck + chip) / 3.0 })),
        ] }) }),
    });
}

runApp(App);
