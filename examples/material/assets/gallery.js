// Elpa Material — widget gallery.
//
// A second application (linked after the SDK, like `demo.js`) that exercises the
// *extended* widget set: layout widgets (Container/Padding/Row+Expanded/Stack+
// Positioned/Wrap/GridView/ListView), the broader Material catalog (TextField,
// IconButton, Avatar, Badge, ListTile, NavigationBar, SegmentedButton,
// CircularProgress, ExpansionTile, Banner, Drawer, Dialog, Snackbar, DataTable),
// content/media (Image, VideoPlayer) and charts (Bar/Line/Pie/Sparkline) — plus
// the platform-service wrappers (storage, clock, network). It composes a widget
// tree and calls `runApp`; it never touches the GPU.
//
// Style note: every showcased widget is built by its own small top-level
// function and sections are assembled from calls — the same idiom the SDK uses.
// (This was once also a workaround for a VM front-end codegen bug with large
// function bodies; that bug is now fixed in `elpian-vm`, so the structure here is
// kept purely for readability.)

// --- application state --------------------------------------------------------
let dark = 0.0; let accent = 0;
let tab = 0;             // bottom-nav section
let menuOpen = 0.0;      // navigation drawer
let dlgOpen = 0.0;       // alert dialog
let snackOn = 0.0;       // snackbar
let playing = 0.0;       // video play/pause
let vpos = 0.35;         // video scrubber position
let fieldText = "";      // text field contents
let seg = 0;             // segmented control selection
let expand = 0.0;        // expansion tile
let likes = 3;           // badge count
let saved = "";          // last value persisted to storage

// A custom SVG-path icon, registered once so it is usable by name anywhere a
// built-in icon is (it is stroked from its path, like the rest of the icon set).
registerIcon("download", "M12 3 L12 14 M7 10 L12 15 L17 10 M5 19 L19 19", 24.0);

// A small reusable custom widget (a captioned control), defined once.
let Labeled = defineComponent(function(props, update) {
    return Column({ gap: 1.6, cross: "start", children: [
        Text(props.label, { size: "caption" }),
        props.child,
    ] });
});

// ============================ layout section ==================================
function galContainerDemo() {
    return Container({ width: 88.0, height: 11.0, color: "primary", radius: 3.0,
        child: Center({ child: Text("CONTAINER + CENTER", { size: "label", ink: "onAccent" }) }) });
}
function galRowDemo() {
    return Labeled({ label: "ROW WITH EXPANDED (1:2:1)", child: Row({ width: 88.0, gap: 2.0, children: [
        Expanded({ flex: 1.0, child: Container({ height: 7.0, color: "surfaceHigh", radius: 2.0 }) }),
        Expanded({ flex: 2.0, child: Container({ height: 7.0, color: "primary", radius: 2.0 }) }),
        Expanded({ flex: 1.0, child: Container({ height: 7.0, color: "surfaceHigh", radius: 2.0 }) }),
    ] }) });
}
function galWrapDemo(update) {
    let chips = [];
    let words = ["DESIGN", "BUILD", "SHIP", "SCALE", "TEST", "PROFILE"];
    for (let i = 0; i < 6; i++) { push(chips, Chip({ id: concat("c", str(i)), label: words[i], value: 0.0, onTap: () => { update(); } })); }
    return Labeled({ label: "WRAP", child: Wrap({ maxWidth: 88.0, gap: 2.0, runGap: 2.0, children: chips }) });
}
function galStackDemo() {
    return Labeled({ label: "STACK + POSITIONED", child: Stack({ width: 88.0, height: 16.0, children: [
        Container({ width: 88.0, height: 16.0, color: "surface", radius: 2.0 }),
        Positioned({ left: 3.0, top: 3.0, child: Avatar({ label: "EL" }) }),
        Positioned({ right: 3.0, bottom: 2.0, child: Badge({ count: likes, child: Icon({ icon: "bell", size: 5.0 }) }) }),
    ] }) });
}
function galGridDemo() {
    let cells = [];
    for (let i = 0; i < 9; i++) {
        let role = "surfaceHigh"; if (i % 3 == 0) { role = "primary"; }
        push(cells, Container({ color: role, radius: 2.0 }));
    }
    // Responsive reflow: a phone shows a 2-column grid (taller cells), a larger
    // screen the original 3 columns — the Material "fewer columns when narrow"
    // pattern, driven by the size-class API.
    let cols = 3; let label = "GRIDVIEW (3 COLS)";
    if (isCompact() > 0.5) { cols = 2; label = "GRIDVIEW (2 COLS, PHONE)"; }
    return Labeled({ label: label, child: GridView({ id: "grid1", cols: cols, width: 88.0, height: 30.0, gap: 2.0, cellHeight: 13.0, children: cells }) });
}
function galLayout(update) {
    let k = [];
    push(k, Text("LAYOUT", { size: "title" }));
    push(k, galContainerDemo());
    push(k, galRowDemo());
    push(k, galWrapDemo(update));
    push(k, galStackDemo());
    push(k, galGridDemo());
    return ListView({ id: "layoutList", width: 92.0, height: 70.0, gap: 4.5, children: k });
}

// ============================ widgets section =================================
function galFieldDemo(update) {
    return TextField({ id: "nameField", label: "YOUR NAME", placeholder: "TYPE HERE", value: fieldText, width: 88.0,
        onChange: (v) => { fieldText = v; update(); } });
}
function galIconRow(update) {
    // A full-width action row: the controls spread evenly across the content
    // column (`main: "around"`) instead of huddling in the centre.
    return Row({ width: 88.0, main: "around", children: [
        IconButton({ icon: "heart", onTap: () => { likes = likes + 1; update(); } }),
        IconButton({ icon: "star", onTap: () => { update(); } }),
        IconButton({ icon: "settings", onTap: () => { update(); } }),
        Badge({ count: likes, child: Icon({ icon: "bell", size: 5.0 }) }),
    ] });
}
function galSegDemo(update) {
    // Full-width segmented control (a tab-bar-style selector) rather than a
    // shrunken pill floating in the middle of the row.
    return SegmentedButton({ segments: ["DAY", "WEEK", "MONTH"], index: seg, width: 88.0,
        onChange: (i) => { seg = i; update(); } });
}
function galTileA(update) {
    return ListTile({ leading: "person", title: "ADA LOVELACE", subtitle: "FIRST PROGRAMMER", trailing: "check",
        width: 88.0, onTap: () => { snackOn = 1.0; update(); } });
}
function galTileB() {
    return ListTile({ leading: "home", title: "DASHBOARD", subtitle: "OVERVIEW + STATS", trailing: "back", width: 88.0 });
}
function galExpansionDemo(update) {
    return ExpansionTile({ title: "MORE DETAILS", expanded: expand, width: 88.0,
        onToggle: () => { expand = 1.0 - expand; update(); },
        child: Padding({ pad: 2.0, child: Text("REVEALED CONTENT INSIDE THE TILE.", { size: "body" }) }) });
}
function galProgRow() {
    return Row({ width: 88.0, main: "around", children: [
        Labeled({ label: "PROGRESS", child: CircularProgress({ id: "cp1", value: 0.62 }) }),
        Labeled({ label: "AVATAR", child: Avatar({ icon: "person" }) }),
    ] });
}
function galBtnRow(update) {
    // The two actions share the full width equally (`Expanded`), filling the row
    // instead of sitting as two small pills with dead space around them.
    return Row({ width: 88.0, gap: 4.0, children: [
        Expanded({ child: FilledButton({ label: "DIALOG", onTap: () => { dlgOpen = 1.0; update(); } }) }),
        Expanded({ child: OutlinedButton({ label: "SNACK", onTap: () => { snackOn = 1.0; update(); } }) }),
    ] });
}
// Typography: real font sizing (named roles + explicit px) and weights, all from
// the same stroke font.
function galTypeDemo() {
    return Labeled({ label: "TYPOGRAPHY (SIZE + WEIGHT)", child: Column({ gap: 1.2, cross: "start", children: [
        Text("HEADLINE BOLD", { size: "headline", weight: "bold" }),
        Text("TITLE MEDIUM", { size: "title", weight: "medium" }),
        Text("BODY REGULAR", { size: "body" }),
        Text("LABEL LIGHT", { size: "label", weight: "light" }),
    ] }) });
}
// SVG-path icons: a registered one (by name) and two inline paths (one all-line,
// one with cubic Béziers), each stroked into the icon box.
function galSvgRow() {
    return Labeled({ label: "SVG ICONS (STROKED PATHS)", child: Row({ gap: 4.0, children: [
        Icon({ icon: "download", size: 7.0, color: "primary" }),
        Icon({ svg: "M12 21 C12 21 4 14 4 8 C4 5 6 3 9 3 C11 3 12 5 12 5 C12 5 13 3 15 3 C18 3 20 5 20 8 C20 14 12 21 12 21 Z", size: 7.0, color: "primary" }),
        Icon({ svg: "M5 12 H19 M13 6 L19 12 L13 18", size: 7.0 }),
    ] }) });
}
function galWidgets(update) {
    let k = [];
    push(k, Text("WIDGETS", { size: "title" }));
    push(k, galFieldDemo(update));
    push(k, galIconRow(update));
    push(k, galSegDemo(update));
    push(k, galTileA(update));
    push(k, galTileB());
    push(k, galExpansionDemo(update));
    push(k, galProgRow());
    push(k, galBtnRow(update));
    push(k, Banner({ icon: "bell", message: "3 UPDATES AVAILABLE" }));
    push(k, galTypeDemo());
    push(k, galSvgRow());
    return ListView({ id: "widgetsList", width: 92.0, height: 70.0, gap: 4.5, children: k });
}

// ============================ charts section ==================================
function galBarDemo() {
    return Labeled({ label: "BAR", child: BarChart({ width: 88.0, height: 24.0,
        labels: ["A", "B", "C", "D", "E", "F"], data: [3.0, 7.0, 5.0, 9.0, 4.0, 6.0] }) });
}
function galLineDemo() {
    return Labeled({ label: "LINE", child: LineChart({ width: 88.0, height: 24.0, data: [2.0, 5.0, 3.0, 8.0, 6.0, 9.0, 7.0] }) });
}
function galPieDemo() {
    return Labeled({ label: "PIE", child: Center({ child: PieChart({ radius: 14.0, hole: 0.45, data: [
        { value: 40.0, colorIndex: 0 }, { value: 25.0, colorIndex: 1 },
        { value: 20.0, colorIndex: 2 }, { value: 15.0, colorIndex: 3 } ] }) }) });
}
function galSparkDemo() {
    return Labeled({ label: "SPARKLINE", child: Sparkline({ width: 40.0, height: 6.0, data: [1.0, 3.0, 2.0, 5.0, 4.0, 6.0, 5.0, 7.0] }) });
}
function galTableDemo() {
    return Labeled({ label: "DATA TABLE", child: DataTable({ columns: ["NAME", "SCORE"],
        rows: [["ADA", 95], ["ALAN", 88], ["GRACE", 92]], colWidth: 30.0 }) });
}
function galCharts(update) {
    let k = [];
    push(k, Text("CHARTS", { size: "title" }));
    push(k, galBarDemo());
    push(k, galLineDemo());
    push(k, galPieDemo());
    push(k, galSparkDemo());
    push(k, galTableDemo());
    return ListView({ id: "chartsList", width: 92.0, height: 70.0, gap: 4.5, children: k });
}

// ============================ media section ===================================
function galImageDemo() {
    return Image({ width: 88.0, height: 36.0, radius: 2.0, label: "PLACEHOLDER IMAGE" });
}
function galVideoDemo(update) {
    return VideoPlayer({ id: "vid", width: 88.0, height: 40.0, playing: playing, value: vpos,
        onToggle: () => { playing = 1.0 - playing; update(); },
        onSeek: (v) => { vpos = v; update(); } });
}
function galNetStatus() {
    let net = { s: 0 };
    httpGet("https://example.com/", (st, body) => { net.s = st; });
    if (net.s > 0) { return "ONLINE"; }
    return "OFFLINE (NET CAP OFF)";
}
function galStorageTile() {
    return ListTile({ leading: "check", title: concat("SAVED: ", saved), subtitle: concat("CLOCK MS: ", str(now())), width: 88.0 });
}
function galNetTile() {
    return ListTile({ leading: "bell", title: concat("NETWORK: ", galNetStatus()), subtitle: "SYNC HTTP VIA HOST", width: 88.0 });
}
function galSaveBtn(update) {
    return FilledButton({ label: "SAVE NAME", onTap: () => {
        storeWrite("/gallery/name", fieldText); saved = storeRead("/gallery/name"); update();
    } });
}
function galMedia(update) {
    let k = [];
    push(k, Text("MEDIA", { size: "title" }));
    push(k, galImageDemo());
    push(k, galVideoDemo(update));
    push(k, Text("PLATFORM SERVICES", { size: "caption" }));
    push(k, galStorageTile());
    push(k, galNetTile());
    push(k, galSaveBtn(update));
    return ListView({ id: "mediaList", width: 92.0, height: 70.0, gap: 4.5, children: k });
}

function galBody(update) {
    if (tab == 1) { return galWidgets(update); }
    if (tab == 2) { return galCharts(update); }
    if (tab == 3) { return galMedia(update); }
    return galLayout(update);
}

// ============================ root component ==================================
// The bottom navigation's four destinations.
function galMenuItems() {
    return [
        { icon: "home", label: "LAYOUT" }, { icon: "settings", label: "WIDGETS" },
        { icon: "chart", label: "CHARTS" }, { icon: "video", label: "MEDIA" },
    ];
}
// The drawer's menu: the same four destinations grouped under a section caption,
// then a divider and a second group of (decorative) destinations — exercising
// section headers, dividers and more than three entries. Only `{ icon, label }`
// rows count toward the selected index, so the first four align with `tab`.
function galDrawerItems() {
    return [
        { section: "BROWSE" },
        { icon: "home", label: "LAYOUT" }, { icon: "settings", label: "WIDGETS" },
        { icon: "chart", label: "CHARTS" }, { icon: "video", label: "MEDIA" },
        { divider: 1 },
        { section: "LIBRARY" },
        { icon: "heart", label: "FAVORITES" }, { icon: "download", label: "DOWNLOADS" },
        { icon: "bell", label: "NOTIFICATIONS" },
    ];
}
function galKey(k, update) {
    if (k == "t") { tab = (tab + 1) % 4; }
    if (k == "m") { menuOpen = 1.0 - menuOpen; }
    if (k == "g") { dlgOpen = 1.0 - dlgOpen; }
    if (k == "s") { snackOn = 1.0 - snackOn; }
    if (k == "p") { playing = 1.0 - playing; }
    if (k == "d") { dark = 1.0 - dark; }
    // 'f' downloads a web font by URL and uses it as the main font; 'F' restores
    // the default font (itself downloaded by the runtime). The runtime fetches and
    // rasterises it; the UI repaints in the new face. (`useFont` repaints itself,
    // so no `update()` is needed here.)
    if (k == "f") { useFont("https://cdn.jsdelivr.net/npm/@expo-google-fonts/pacifico@0.2.3/Pacifico_400Regular.ttf"); return 0; }
    if (k == "F") { useDefaultFont(); return 0; }
    update();
}
function galDialog(update) {
    return Dialog({ title: "CONFIRM", message: "THIS ALERT DIALOG IS A MODAL OVERLAY RENDERED BY THE SCAFFOLD.",
        actions: [
            { label: "CANCEL", onTap: () => { dlgOpen = 0.0; update(); } },
            { label: "OK", onTap: () => { dlgOpen = 0.0; snackOn = 1.0; update(); } },
        ] });
}

let App = defineComponent(function(props, update) {
    setTheme(dark, accent);
    let items = galMenuItems();
    let sc = {
        onKey: (k) => { galKey(k, update); },
        appBar: AppBar({ title: "ELPA GALLERY",
            onMenu: () => { menuOpen = 1.0; update(); },
            onAction: () => { dark = 1.0 - dark; update(); } }),
        fab: Fab({ onTap: () => { accent = (accent + 1) % 4; update(); } }),
        bottomBar: NavigationBar({ index: tab, items: items, onChange: (i) => { tab = i; update(); } }),
        body: galBody(update),
        drawer: Drawer({ open: menuOpen, header: "ELPA GALLERY", subtitle: "DESIGN SYSTEM DEMO",
            avatarIcon: "person", index: tab, items: galDrawerItems(),
            // The first four destinations switch sections; the decorative extras
            // just acknowledge with a snackbar. Either way the drawer closes.
            onSelect: (i) => { if (i < 4) { tab = i; } else { snackOn = 1.0; } menuOpen = 0.0; update(); },
            onClose: () => { menuOpen = 0.0; update(); } }),
    };
    if (dlgOpen > 0.5) { sc.dialog = galDialog(update); }
    if (snackOn > 0.5) {
        sc.snackbar = Snackbar({ message: "ACTION COMPLETED", actionLabel: "UNDO",
            onAction: () => { snackOn = 0.0; update(); } });
    }
    return Scaffold(sc);
});

runApp(App);
