// Elpa Flutter — demo app: "Elpa Sound", a realistic multi-screen Material app.
//
// A faithful little Flutter application built entirely from the layered SDK:
//
//   • MaterialApp + a live light/dark ThemeData (toggled from Settings).
//   • A Scaffold with an AppBar, a slide-in Drawer (scrim + AnimatedPositioned),
//     a BottomNavigationBar, and a FloatingActionButton.
//   • Four screens, each its own widget so switching tabs mounts a fresh,
//     independently-scrolled subtree:
//       - Discover : a ListView with a "now playing" hero (gradient, shadow, an
//                    animated Sparkline, a determinate + an indeterminate
//                    progress indicator), a Wrap of action Chips, trending Cards.
//       - Browse   : a scrollable GridView of genre tiles with fling physics.
//       - Library  : a ListView.builder of 40 ListTiles (materialise + paint
//                    culling), draggable with momentum.
//       - Settings : Switches (one re-themes the whole app), a Slider, a Radio
//                    group, Checkboxes, a sliding TabBar, and a counter.
//
// Every interaction runs the real Flutter loop on the Elpa VM: build → element
// reconcile → render layout → dart:ui paint (with GPU clipping) → one cheap
// partial gpu.submit; AnimationControllers tick on real frame dt for smooth 60fps.

// ----------------------------------------------------------------- themes -----
function appLightTheme() {
    return new ThemeData(
        colorRGBO(99, 91, 255, 1.0), Colors.white,
        Colors.white, colorRGBO(24, 26, 34, 1.0), colorRGBO(244, 245, 250, 1.0));
}
function appDarkTheme() {
    return new ThemeData(
        colorRGBO(150, 140, 255, 1.0), colorRGBO(22, 22, 30, 1.0),
        colorRGBO(32, 33, 42, 1.0), colorRGBO(236, 238, 248, 1.0), colorRGBO(18, 19, 26, 1.0));
}

// ----------------------------------------------------------- shared widgets ---
// A little stroked sparkline that gently breathes via an AnimationController.
class Sparkline extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "Sparkline"; }
    createState() { return new SparklineState(); }
}
class SparklineState extends State {
    initState() { this.controller = new AnimationController({ duration: 2600.0 }); this.controller.repeat({ reverse: true }); }
    dispose() { this.controller.dispose(); }
    build(context) {
        let self = this; let color = this.widget.p.color;
        return AnimatedBuilder({ animation: this.controller, builder: (ctx, ch) => {
            let ph = self.controller.value();
            return CustomPaint({ height: 64.0, painter: (canvas, sz) => {
                let base = [0.25, 0.5, 0.32, 0.72, 0.5, 0.88, 0.6, 0.97, 0.7];
                let p0 = path(); let n = len(base);
                for (let i = 0; i < n; i++) {
                    let wob = sin(ph * 6.2831853 + num(i) * 0.7) * 0.06;
                    let x = sz.width * (num(i) / (n - 1.0));
                    let y = sz.height * (1.0 - clamp01(base[i] + wob)) * 0.92 + 3.0;
                    if (i == 0) { p0.moveTo(x, y); } else { p0.lineTo(x, y); }
                }
                canvas.drawPath(p0, paintStroke(color, 3.0));
            } });
        } });
    }
}
function sectionTitle(text, theme) {
    return Padding({ padding: edgeOnly(20.0, 20.0, 20.0, 10.0),
        child: Text(text, { fontSize: 17.0, color: theme.onSurface }) });
}
function trackColor(i) {
    let pal = [Colors.deepPurple, Colors.teal, Colors.deepOrange, Colors.blue, Colors.pink, Colors.green];
    return pal[i % len(pal)];
}

// =============================================================== Discover ======
class DiscoverScreen extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "DiscoverScreen"; }
    build(context) {
        let app = this.p.app; let theme = this.p.theme;
        let chipNames = ["For You", "Focus", "Workout", "Chill", "Top 50", "Fresh"];
        let chips = [];
        for (let i = 0; i < len(chipNames); i++) {
            push(chips, Chip({ label: chipNames[i], avatar: new IconWidget({ icon: "music_note", size: 14.0, color: theme.primary }) }));
        }
        let trending = [
            { t: "Midnight Drive", s: "Neon Skies · 3:42" },
            { t: "Ocean Breathing", s: "Calm Tides · 5:18" },
            { t: "Gravity", s: "The Vectors · 4:05" },
            { t: "Paper Planes", s: "Lo-Fi Loft · 2:55" },
        ];
        let cards = [];
        for (let i = 0; i < len(trending); i++) {
            let it = trending[i]; let accent = trackColor(i);
            push(cards, Card({ child: ListTile({
                leading: Container({ width: 46.0, height: 46.0, alignment: Alignments.center,
                    decoration: { color: withOpacity(accent, 0.18), borderRadius: 12.0 },
                    child: new IconWidget({ icon: "music_note", size: 22.0, color: accent }) }),
                title: it.t, subtitle: it.s,
                trailing: new IconWidget({ icon: "play_arrow", size: 22.0, color: theme.primary }),
                onTap: () => { } }) }));
        }
        let kids = [
            Padding({ padding: edgeAll(16.0), child: heroNowPlaying(theme, app.likes) }),
            sectionTitle("Quick mixes", theme),
            Padding({ padding: edgeSymmetric(16.0, 0.0), child: Wrap({ spacing: 10.0, runSpacing: 10.0, children: chips }) }),
            sectionTitle("Trending now", theme),
        ];
        for (let i = 0; i < len(cards); i++) { push(kids, Padding({ padding: edgeSymmetric(10.0, 0.0), child: cards[i] })); }
        push(kids, SizedBox({ height: 96.0 }));
        return ListView({ children: kids });
    }
}
function heroNowPlaying(theme, likes) {
    return Container({
        padding: edgeAll(20.0),
        decoration: {
            gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), [colorRGBO(99, 91, 255, 1.0), colorRGBO(168, 86, 255, 1.0)], 0),
            borderRadius: 22.0,
            boxShadow: [{ color: withOpacity(colorRGBO(99, 91, 255, 1.0), 0.45), blur: 22.0, dy: 10.0 }],
        },
        child: Column({ mainAxisSize: "min", crossAxisAlignment: "start", children: [
            Row({ crossAxisAlignment: "center", children: [
                new IconWidget({ icon: "play_arrow", size: 18.0, color: Colors.white }),
                SizedBox({ width: 8.0 }),
                Text("NOW PLAYING", { fontSize: 12.0, color: withOpacity(Colors.white, 0.85) }),
                Spacer({}),
                new IconWidget({ icon: "favorite", size: 16.0, color: Colors.white }),
                SizedBox({ width: 6.0 }),
                Text(str(likes), { fontSize: 13.0, color: Colors.white }),
            ] }),
            SizedBox({ height: 12.0 }),
            Text("Aurora", { fontSize: 26.0, color: Colors.white }),
            Text("Elpa Sound · Synthwave", { fontSize: 13.0, color: withOpacity(Colors.white, 0.85) }),
            SizedBox({ height: 12.0 }),
            new Sparkline({ color: withOpacity(Colors.white, 0.95) }),
            SizedBox({ height: 14.0 }),
            LinearProgressIndicator({ value: 0.42, color: Colors.white }),
            SizedBox({ height: 10.0 }),
            Row({ crossAxisAlignment: "center", children: [
                Text("1:34", { fontSize: 11.0, color: withOpacity(Colors.white, 0.8) }),
                Spacer({}),
                Text("3:42", { fontSize: 11.0, color: withOpacity(Colors.white, 0.8) }),
            ] }),
        ] }),
    });
}

// ================================================================ Browse =======
class BrowseScreen extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "BrowseScreen"; }
    build(context) {
        let genres = ["Pop", "Synthwave", "Lo-Fi", "Jazz", "Classical", "Hip-Hop", "Ambient", "Rock", "Electronic", "Indie", "Soul", "Focus"];
        return GridViewBuilder({ crossAxisCount: 2.0, spacing: 14.0, childAspectRatio: 1.5, itemCount: num(len(genres)),
            itemBuilder: (i) => {
                let accent = trackColor(i);
                let pad = edgeOnly(16.0, 0.0, 0.0, 0.0); if (i < 2) { pad = edgeOnly(16.0, 16.0, 0.0, 0.0); }
                return Padding({ padding: pad,
                    child: GestureDetector({ onTap: () => { },
                        child: Container({ padding: edgeAll(16.0),
                            decoration: { gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), [accent, withOpacity(accent, 0.6)], 0), borderRadius: 18.0,
                                boxShadow: [{ color: withOpacity(accent, 0.4), blur: 14.0, dy: 6.0 }] },
                            child: Column({ mainAxisAlignment: "spaceBetween", crossAxisAlignment: "start", children: [
                                new IconWidget({ icon: "music_note", size: 26.0, color: Colors.white }),
                                Text(genres[i], { fontSize: 18.0, color: Colors.white }),
                            ] }) }) }) });
            } });
    }
}

// ================================================================ Library ======
class LibraryScreen extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "LibraryScreen"; }
    build(context) {
        let theme = this.p.theme;
        let titles = ["Aurora", "Midnight Drive", "Paper Planes", "Gravity", "Ocean Breathing", "Neon", "Solstice", "Echoes", "Reverie", "Glass"];
        return ListViewBuilder({ itemCount: 40.0, itemBuilder: (i) => {
            let accent = trackColor(i); let name = concat(titles[i % len(titles)], concat(" #", str(i + 1)));
            return Column({ mainAxisSize: "min", crossAxisAlignment: "stretch", children: [
                ListTile({
                    leading: CircleAvatar({ radius: 22.0, backgroundColor: withOpacity(accent, 0.2),
                        child: new IconWidget({ icon: "music_note", size: 20.0, color: accent }) }),
                    title: name, subtitle: concat("Track ", concat(str(i + 1), " · 3:20")),
                    trailing: IconButton({ icon: "more_vert", color: withOpacity(theme.onSurface, 0.5), onPressed: () => { } }),
                    onTap: () => { } }),
                Divider({ height: 1.0, thickness: 1.0, indent: 80.0, color: withOpacity(theme.onSurface, 0.08) }),
            ] });
        } });
    }
}

// =============================================================== Settings ======
class SettingsScreen extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "SettingsScreen"; }
    build(context) {
        let app = this.p.app; let theme = this.p.theme; let s = app;
        let qualities = ["Low", "High", "Lossless"];
        let radios = [];
        for (let i = 0; i < len(qualities); i++) {
            let q = qualities[i];
            push(radios, GestureDetector({ onTap: () => { s.set(() => { s.quality = q; }); },
                child: Container({ color: withOpacity(Colors.white, 0.0), padding: edgeSymmetric(16.0, 6.0),
                    child: Row({ crossAxisAlignment: "center", children: [
                        Radio({ value: q, groupValue: app.quality, onChanged: (v) => { s.set(() => { s.quality = v; }); } }),
                        SizedBox({ width: 10.0 }),
                        Text(q, { fontSize: 15.0, color: theme.onSurface }),
                    ] }) }) }));
        }
        let tabContent = [
            settingsTabBody("Streaming over cellular uses more data. Wi-Fi-only keeps your plan happy.", theme),
            settingsTabBody("Downloads are stored on-device for offline listening, up to 10,000 tracks.", theme),
            settingsTabBody("Equalizer presets shape the sound. Try Bass Boost or Acoustic for a change.", theme),
        ];
        let kids = [
            sectionTitle("Playback", theme),
            settingsSwitchTile("Dark mode", "Re-themes the whole app live", "settings", app.dark, (v) => { s.set(() => { s.dark = v; }); }, theme),
            settingsSwitchTile("Notifications", "New releases and mixes", "notifications", app.notif, (v) => { s.set(() => { s.notif = v; }); }, theme),
            settingsSwitchTile("Wi-Fi only", "Stream on Wi-Fi to save data", "info", app.wifiOnly, (v) => { s.set(() => { s.wifiOnly = v; }); }, theme),
            Card({ child: Padding({ padding: edgeSymmetric(16.0, 14.0), child: Column({ mainAxisSize: "min", crossAxisAlignment: "stretch", children: [
                Row({ crossAxisAlignment: "center", children: [
                    new IconWidget({ icon: "music_note", size: 20.0, color: theme.primary }),
                    SizedBox({ width: 12.0 }),
                    Text("Volume", { fontSize: 15.0, color: theme.onSurface }),
                    Spacer({}),
                    Text(concat(str(round(app.volume * 100.0)), "%"), { fontSize: 14.0, color: withOpacity(theme.onSurface, 0.6) }),
                ] }),
                Slider({ value: app.volume, onChanged: (v) => { s.set(() => { s.volume = v; }); } }),
            ] }) }) }),
            sectionTitle("Audio quality", theme),
            Card({ child: Column({ mainAxisSize: "min", crossAxisAlignment: "stretch", children: radios }) }),
            sectionTitle("Library", theme),
            Card({ child: Padding({ padding: edgeAll(8.0), child: Column({ mainAxisSize: "min", crossAxisAlignment: "stretch", children: [
                checkRow("Smart downloads", app.downloads, (v) => { s.set(() => { s.downloads = v; }); }, theme),
                checkRow("Show explicit content", app.explicit, (v) => { s.set(() => { s.explicit = v; }); }, theme),
            ] }) }) }),
            sectionTitle("About", theme),
            Padding({ padding: edgeSymmetric(10.0, 0.0), child: Card({ child: SizedBox({ height: 188.0,
                child: TabsView({ tabs: ["Cellular", "Storage", "Sound"], views: tabContent }) }) }) }),
            Padding({ padding: edgeAll(20.0), child: Center({ child: ElevatedButton({ label: "RESET TO DEFAULTS",
                onPressed: () => { s.set(() => { s.volume = 0.55; s.quality = "High"; s.dark = false; }); } }) }) }),
            SizedBox({ height: 96.0 }),
        ];
        return ListView({ children: kids });
    }
}
function settingsSwitchTile(title, subtitle, icon, value, onChanged, theme) {
    return Card({ child: Padding({ padding: edgeSymmetric(16.0, 8.0), child: Row({ crossAxisAlignment: "center", children: [
        new IconWidget({ icon: icon, size: 20.0, color: theme.primary }),
        SizedBox({ width: 14.0 }),
        Expanded({ child: Column({ mainAxisSize: "min", crossAxisAlignment: "start", children: [
            Text(title, { fontSize: 15.0, color: theme.onSurface }),
            SizedBox({ height: 2.0 }),
            Text(subtitle, { fontSize: 12.0, color: withOpacity(theme.onSurface, 0.55) }),
        ] }) }),
        Switch({ value: value, onChanged: onChanged }),
    ] }) }) });
}
function checkRow(label, value, onChanged, theme) {
    return GestureDetector({ onTap: () => { onChanged(!value); },
        child: Container({ color: withOpacity(Colors.white, 0.0), padding: edgeSymmetric(8.0, 8.0),
            child: Row({ crossAxisAlignment: "center", children: [
                Checkbox({ value: value, onChanged: onChanged }),
                SizedBox({ width: 12.0 }),
                Text(label, { fontSize: 15.0, color: theme.onSurface }),
            ] }) }) });
}
function settingsTabBody(text, theme) {
    return Padding({ padding: edgeAll(18.0), child: Align({ alignment: Alignments.topLeft,
        child: Text(text, { fontSize: 14.0, color: withOpacity(theme.onSurface, 0.75) }) }) });
}

// =============================================================== Drawer ========
class AppDrawer extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "AppDrawer"; }
    build(context) {
        let app = this.p.app; let theme = this.p.theme; let s = app;
        let entries = [
            { ic: "home", label: "Discover", i: 0 },
            { ic: "search", label: "Browse", i: 1 },
            { ic: "music_note", label: "Library", i: 2 },
            { ic: "settings", label: "Settings", i: 3 },
        ];
        let tiles = [];
        for (let k = 0; k < len(entries); k++) {
            let e = entries[k]; let sel = app.tab == e.i;
            push(tiles, ListTile({
                leading: new IconWidget({ icon: e.ic, size: 22.0, color: sel ? theme.primary : withOpacity(theme.onSurface, 0.6) }),
                title: e.label,
                onTap: () => { s.go(e.i); let sc = scaffoldOf(context); if (sc != 0) { sc.closeDrawer(); } } }));
        }
        let head = DrawerHeader({
            gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), [colorRGBO(99, 91, 255, 1.0), colorRGBO(168, 86, 255, 1.0)], 0),
            child: Column({ mainAxisSize: "min", crossAxisAlignment: "start", children: [
                CircleAvatar({ radius: 26.0, backgroundColor: withOpacity(Colors.white, 0.25), child: new IconWidget({ icon: "person", size: 28.0, color: Colors.white }) }),
                SizedBox({ height: 12.0 }),
                Text("Alex Rivera", { fontSize: 18.0, color: Colors.white }),
                Text("Premium member", { fontSize: 12.0, color: withOpacity(Colors.white, 0.85) }),
            ] }) });
        let kids = [head]; for (let k = 0; k < len(tiles); k++) { push(kids, tiles[k]); }
        push(kids, Divider({}));
        push(kids, ListTile({ leading: new IconWidget({ icon: "info", size: 22.0, color: withOpacity(theme.onSurface, 0.6) }), title: "About Elpa Sound", onTap: () => { let sc = scaffoldOf(context); if (sc != 0) { sc.closeDrawer(); } } }));
        return Column({ mainAxisSize: "max", crossAxisAlignment: "stretch", children: kids });
    }
}

// ================================================================= app =========
class StoreApp extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "StoreApp"; }
    createState() { return new StoreAppState(); }
}
class StoreAppState extends State {
    initState() {
        this.tab = 0; this.likes = 248; this.dark = false;
        this.notif = true; this.wifiOnly = false; this.downloads = true; this.explicit = false;
        this.volume = 0.55; this.quality = "High";
    }
    go(i) { let s = this; this.setState(() => { s.tab = i; }); }
    set(fn) { this.setState(fn); }
    build(context) {
        let s = this; let theme = this.dark ? appDarkTheme() : appLightTheme();
        let titles = ["Discover", "Browse", "Library", "Settings"];
        let body = 0;
        if (this.tab == 0) { body = new DiscoverScreen({ app: s, theme: theme }); }
        else { if (this.tab == 1) { body = new BrowseScreen({ app: s, theme: theme }); }
        else { if (this.tab == 2) { body = new LibraryScreen({ app: s, theme: theme }); }
        else { body = new SettingsScreen({ app: s, theme: theme }); } } }
        let sp = {
            appBar: AppBar({ title: titles[this.tab], actions: [
                IconButton({ icon: "search", color: theme.onPrimary, onPressed: () => { } }),
                IconButton({ icon: "more_vert", color: theme.onPrimary, onPressed: () => { } }),
            ] }),
            drawer: Drawer({ child: new AppDrawer({ app: s, theme: theme }) }),
            bottomNavigationBar: BottomNavigationBar({ currentIndex: this.tab, onTap: (i) => { s.go(i); }, items: [
                BottomNavigationBarItem("home", "Discover"), BottomNavigationBarItem("search", "Browse"),
                BottomNavigationBarItem("music_note", "Library"), BottomNavigationBarItem("settings", "Settings"),
            ] }),
            body: body,
        };
        if (this.tab == 0) { sp.floatingActionButton = FloatingActionButton({ icon: "favorite", onPressed: () => { s.set(() => { s.likes = s.likes + 1; }); } }); }
        return MaterialApp({ theme: theme, home: Scaffold(sp) });
    }
}

runApp(new StoreApp({}));
