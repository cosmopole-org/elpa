// Elpa Liquid Glass demo — the application, in JavaScript.
//
// It uses the Liquid Glass SDK (linked ahead of this file) as a pure black box:
// it declares state and composes a widget tree. There is no `gpu.submit`, no
// glyphs, no coordinates — and no idea that the chrome is two GPU passes of
// refracted glass. Custom components are `(props, update) => widget` functions
// wrapped with `defineComponent`; a handler mutates state and calls `update()`,
// which repaints only that component.

// --- application state --------------------------------------------------------
let dark = 0.0;
let accent = 0;
let swOn = 1.0; let vol = 0.4; let chip = 0.0;
let seg = 0; let nav = 0; let tab = 0;
let sheetOpen = 0.0;

// A caption stacked above a control.
let Field = defineComponent(function(props, update) {
    return Column({ gap: 1.2, cross: "start", children: [
        Text(props.label, { size: "caption", ink: "soft", weight: "medium" }),
        props.child,
    ] });
});

// The segmented control is self-contained, so it owns its own update.
let Segments = defineComponent(function(props, update) {
    return SegmentedButton({ segments: ["DAY", "WEEK", "YEAR"], selected: seg,
        onSelect: (i) => { seg = i; update(); } });
});

let App = defineComponent(function(props, update) {
    setTheme(dark, accent);
    return Scaffold({
        onKey: (k) => {
            if (k == "d") { dark = 1.0 - dark; }
            if (k == " ") { swOn = 1.0 - swOn; }
            if (k == "a") { accent = (accent + 1) % 4; }
            if (k == "s") { sheetOpen = 1.0 - sheetOpen; }
            if (k == "ArrowRight") { vol = clamp01(vol + 0.05); }
            if (k == "ArrowLeft") { vol = clamp01(vol - 0.05); }
            update();
        },
        appBar: AppBar({ title: "LIQUID GLASS", onMenu: () => {}, onAction: () => { accent = (accent + 1) % 4; update(); } }),
        fab: Fab({ accent: 1.0, icon: "add", onTap: () => { sheetOpen = 1.0; update(); } }),
        bottomBar: NavigationBar({ selected: nav, items: [
            { icon: "home", label: "HOME" }, { icon: "search", label: "SEARCH" },
            { icon: "heart", label: "SAVED" }, { icon: "person", label: "ME" } ],
            onSelect: (i) => { nav = i; update(); } }),
        body: ListView({ glass: 0.0, children: [
            GlassCard({ thick: 1.0, child: Column({ gap: 3.0, cross: "start", children: [
                Text("CONTROLS", { size: "title", weight: "bold" }),
                Row({ gap: 4.0, children: [
                    FilledButton({ label: "ACTION", onTap: () => { accent = (accent + 1) % 4; update(); } }),
                    GlassButton({ label: "GLASS", onTap: () => { dark = 1.0 - dark; update(); } }),
                    OutlinedButton({ label: "MORE", onTap: () => { sheetOpen = 1.0; update(); } }),
                ] }),
                Row({ gap: 7.0, children: [
                    Field({ label: "WI-FI", child: Switch({ id: "wifi", value: swOn, onTap: () => { swOn = 1.0 - swOn; update(); } }) }),
                    Field({ label: "LIKE", child: Chip({ label: "LIKE", value: chip, onTap: () => { chip = 1.0 - chip; update(); } }) }),
                ] }),
                Field({ label: "VOLUME", child: Slider({ width: 60.0, value: vol, onChanged: (v) => { vol = v; update(); } }) }),
                Field({ label: "RANGE", child: Segments({}) }),
            ] }) }),
            GlassCard({ child: Column({ gap: 2.0, cross: "start", children: [
                Text("LIBRARY", { size: "title", weight: "bold" }),
                ListTile({ icon: "star", title: "Featured", subtitle: "Hand picked for you", trailing: "back" }),
                Divider({}),
                ListTile({ icon: "bell", title: "Notifications", subtitle: "12 new", trailing: "back" }),
                Divider({}),
                ListTile({ icon: "settings", title: "Settings", trailing: "back" }),
            ] }) }),
            GlassCard({ child: Column({ gap: 2.5, cross: "start", children: [
                Text("PROGRESS", { size: "title", weight: "bold" }),
                Progress({ id: "p1", value: vol }),
                Row({ gap: 4.0, children: [
                    CircularProgress({ value: vol }),
                    Avatar({ label: "EL" }),
                    Badge({ count: 3, child: Icon({ icon: "bell", size: 4.0 }) }),
                ] }),
            ] }) }),
            SizedBox({ height: 6.0 }),
        ] }),
        sheet: BottomSheet({ open: sheetOpen, onScrim: () => { sheetOpen = 0.0; update(); },
            child: Column({ gap: 3.0, children: [
                Text("LIQUID GLASS SHEET", { size: "title", weight: "bold" }),
                Text("A frosted panel that refracts the wallpaper behind it.", { size: "body", ink: "soft" }),
                FilledButton({ label: "CLOSE", onTap: () => { sheetOpen = 0.0; update(); } }),
            ] }) }),
    });
});

runApp(App);
