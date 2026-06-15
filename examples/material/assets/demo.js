// Elpa Material Design 3 demo — the application, in JavaScript.
//
// This is what the GitHub Pages deployment runs. It uses the Material SDK
// (linked ahead of this file, like `import 'package:flutter/material.dart'`) as a
// pure black box: it declares state and composes a widget tree. There is no
// `gpu.submit`, no glyph data, no coordinates, and no event plumbing here.
//
// Custom components are plain functions `(props, update) => widget`, wrapped once
// with `defineComponent(...)` to become widget constructors. They are then placed
// in the tree by instantiating them like Flutter widgets — `Tile({ ... })`, no
// `Component(...)` wrapper — and the runtime re-runs **only that component** when
// its `update` is called. A handler mutates state and calls `update()` (the
// Flutter `setState` pattern); the SDK repaints just that component and
// reassembles the frame from the cached output of everything else. State that
// affects several widgets is owned higher up (the radios are self-contained, so
// they live in their own component and update in isolation).

// --- application state --------------------------------------------------------
let dark = 0.0;   // 0 light, 1 dark
let accent = 0;   // accent palette index (cycled by the FAB)
let swOn = 0.0; let ck = 0.0; let chip = 0.0; let radio = 0; let vol = 0.5;

// --- custom widgets: `defineComponent` constructors, instantiated like Flutter -
// A caption stacked above a control. No state, so `update` is unused.
let Tile = defineComponent(function(props, update) {
    return Column({ gap: 1.3, children: [
        Text(props.label, { size: "caption" }),
        props.child,
    ] });
});

// The radio group is self-contained: selecting one only changes the radios, so
// it is its own component and its `update` repaints just this subtree. Each
// radio's tap closure captures its own `idx` and this component's `update`.
// Nested custom widgets just instantiate — `Tile({ ... })`, no wrapper.
let RadioRow = defineComponent(function(props, update) {
    let names = ["A", "B", "C"];
    let kids = [];
    for (let i = 0; i < 3; i++) {
        let idx = i;
        push(kids, Tile({ label: names[idx], child: Radio({
            id: concat("r", str(idx)),
            selected: sel(radio, idx),
            onTap: () => { radio = idx; update(); },
        }) }));
    }
    return Row({ gap: 5.0, children: kids });
});

// --- the root component -------------------------------------------------------
// `update` here re-runs the whole app, which is correct for app-wide state
// (theme, accent) and for controls whose value feeds other widgets (the toggles
// drive the progress bar).
let App = defineComponent(function(props, update) {
    setTheme(dark, accent);
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
                Tile({ label: "WI-FI", child: Switch({ id: "wifi", value: swOn, onTap: () => { swOn = 1.0 - swOn; update(); } }) }),
                Tile({ label: "AGREE", child: Checkbox({ id: "agree", value: ck, onTap: () => { ck = 1.0 - ck; update(); } }) }),
            ] }),
            Tile({ label: "VOLUME", child: Slider({ value: vol, onChanged: (v) => { vol = v; update(); } }) }),
            Tile({ label: "FILTER", child: Chip({ id: "filter", label: "FILTER", value: chip,
                onTap: () => { chip = 1.0 - chip; update(); } }) }),
            RadioRow({}),
            Divider({}),
            Tile({ label: "TASKS", child: Progress({ id: "tasks", value: (swOn + ck + chip) / 3.0 }) }),
        ] }) }),
    });
});

runApp(App);
