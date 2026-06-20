// Elpa Liquid Glass — the public API surface.
//
// The single framework instance `M` (the composition root owning every engine
// service and the retained tree), the widget constructors apps call, the
// component runtime entry points (`defineComponent` / `runApp`), the theme /
// responsive / font controls, the capability-gated platform-service wrappers, and
// the host entry points (`onEvent` / `onFrame` / `onResize`). Everything here is
// a thin delegate to `M` — apps never see the engine internals.

let M = new Glass();

// ---- component runtime -------------------------------------------------------
function Component(fn, props) { return new ComponentNode(fn, props); }
function defineComponent(fn) { return (props) => new ComponentNode(fn, props); }
function runApp(root) { M.runApp(root); }

// ---- theme / responsive ------------------------------------------------------
function setTheme(darkTarget, accent) { M.theme.set(darkTarget, accent); }
function sizeClass() { return M.metrics.sizeClass(); }
function isCompact() { return M.metrics.isCompact(); }
function isMedium() { return M.metrics.isMedium(); }
function isExpanded() { return M.metrics.isExpanded(); }
function screenWidth() { return M.metrics.lw; }
function screenHeight() { return M.metrics.lh; }

// ---- fonts -------------------------------------------------------------------
function useFont(url) { M.font.applyFont({ url: url }, 1.0); M.refont(); }
function useFontBold(url, boldUrl) { M.font.applyFont({ url: url, boldUrl: boldUrl }, 1.0); M.refont(); }
function useFontFromPath(path) { M.font.applyFont({ path: path }, 1.0); M.refont(); }
function useDefaultFont() { M.font.applyFont(0, 0.0); M.refont(); }

// ---- icons -------------------------------------------------------------------
function registerIcon(name, d, viewBox) { M.icons.registerIcon(name, d, viewBox); }

// ---- platform services (capability-gated) ------------------------------------
function okOf(r) { if (isNull(r)) { return 0.0; } if (has(r, "ok")) { if (r.ok) { return 1.0; } } return 0.0; }
function now() { let r = askHost("time.now", []); if (isNull(r)) { return 0; } if (has(r, "ms")) { return r.ms; } return 0; }
function storeWrite(path, data) { return okOf(askHost("fs.write", [{ path: path, data: data }])); }
function storeRead(path) { let r = askHost("fs.read", [{ path: path }]); if (isNull(r)) { return ""; } if (has(r, "data")) { return r.data; } return ""; }
function storeExists(path) { let r = askHost("fs.exists", [{ path: path }]); if (isNull(r)) { return 0.0; } if (has(r, "exists")) { if (r.exists) { return 1.0; } } return 0.0; }
function storeDelete(path) { return okOf(askHost("fs.delete", [{ path: path }])); }
function httpGet(url, onDone) { httpReq("GET", url, 0, onDone); }
function httpPost(url, body, onDone) { httpReq("POST", url, body, onDone); }
function httpReq(method, url, body, onDone) {
    let req = { method: method, url: url };
    if (typeOf(body) == "string") { req.body = body; }
    let r = askHost("net.fetch", [req]);
    if (isNull(r)) { onDone(0, ""); return 0; }
    if (has(r, "ok")) { if (!r.ok) { onDone(0, ""); return 0; } }
    let st = 0; if (has(r, "status")) { st = r.status; }
    let bd = ""; if (has(r, "body")) { bd = r.body; }
    onDone(st, bd); return 0;
}
function randomUnit() { let r = askHost("random.next", []); if (isNull(r)) { return 0.0; } if (has(r, "value")) { return r.value; } return 0.0; }

// ---- widget constructors -----------------------------------------------------
// Layout.
function Container(p) { return new ContainerWidget(p); }
function Padding(p) { return new PaddingWidget(p); }
function SafeArea(p) { return new SafeAreaWidget(p); }
function Center(p) { return new CenterWidget(p); }
function Align(p) { return new AlignWidget(p); }
function SizedBox(p) { return new SizedBoxWidget(p); }
function Spacer(p) { if (isNull(p)) { p = {}; } if (!has(p, "width")) { p.width = 0.0; } if (!has(p, "height")) { p.height = 0.0; } return new SizedBoxWidget(p); }
function Expanded(p) { if (!has(p, "flex")) { p.flex = 1.0; } return new ExpandedWidget(p); }
function Flexible(p) { if (!has(p, "flex")) { p.flex = 1.0; } return new ExpandedWidget(p); }
function Stack(p) { return new StackWidget(p); }
function Positioned(p) { return new PositionedWidget(p); }
function Wrap(p) { return new WrapWidget(p); }
function ListView(p) { if (!has(p, "id")) { p.id = "list"; } return new ListViewWidget(p); }
function GridView(p) { if (!has(p, "id")) { p.id = "grid"; } if (!has(p, "cols")) { p.cols = 2; } return new GridViewWidget(p); }
function Column(p) { return new ColumnWidget(p); }
function Row(p) { return new RowWidget(p); }
function Scaffold(p) { return new ScaffoldWidget(p); }
function Badge(p) { return new BadgeWidget(p); }

// Glass material / content.
function GlassCard(p) { return new GlassCardWidget(p); }
function Card(p) { return new GlassCardWidget(p); }
function Text(t, opt) { if (isNull(opt)) { opt = {}; } if (opt == 0) { opt = {}; } return new TextWidget(t, opt); }
function Icon(p) { return new IconWidget(p); }
function IconButton(p) { if (!has(p, "id")) { if (has(p, "icon")) { p.id = p.icon; } else { p.id = "iconBtn"; } } return new IconButtonWidget(p); }
function AppBar(p) { return new AppBarWidget(p); }
function FilledButton(p) { if (!has(p, "id")) { p.id = p.label; } return new FilledButtonWidget(p); }
function OutlinedButton(p) { if (!has(p, "id")) { p.id = p.label; } return new OutlinedButtonWidget(p); }
function GlassButton(p) { if (!has(p, "id")) { p.id = p.label; } return new GlassButtonWidget(p); }
function Fab(p) { if (isNull(p)) { p = {}; } return new GlassFabWidget(p); }
function Switch(p) { if (!has(p, "id")) { p.id = "switch"; } return new SwitchWidget(p); }
function Slider(p) { return new SliderWidget(p); }
function Chip(p) { if (!has(p, "id")) { p.id = p.label; } return new ChipWidget(p); }
function SegmentedButton(p) { if (!has(p, "id")) { p.id = "seg"; } return new SegmentedButtonWidget(p); }
function NavigationBar(p) { if (!has(p, "id")) { p.id = "nav"; } return new NavigationBarWidget(p); }
function Tabs(p) { if (!has(p, "id")) { p.id = "tabs"; } return new TabsWidget(p); }
function TextField(p) { if (!has(p, "value")) { p.value = ""; } if (!has(p, "id")) { p.id = "field"; } return new TextFieldWidget(p); }
function Divider(p) { if (isNull(p)) { p = {}; } return new DividerWidget(p); }
function Avatar(p) { if (isNull(p)) { p = {}; } return new AvatarWidget(p); }
function Progress(p) { if (!has(p, "id")) { p.id = "progress"; } return new ProgressWidget(p); }
function CircularProgress(p) { if (isNull(p)) { p = {}; } if (!has(p, "id")) { p.id = "circular"; } return new CircularProgressWidget(p); }
function ListTile(p) { if (!has(p, "id")) { p.id = p.title; } return new ListTileWidget(p); }
function Dialog(p) { return new DialogWidget(p); }
function BottomSheet(p) { return new BottomSheetWidget(p); }
function Opacity(p) { return new OpacityWidget(p); }
function Transform(p) { return new TransformWidget(p); }

// Gradient spec builders (plain objects usable as `Container({ gradient })`).
function LinearGradient(colors, opt) { let g = { type: "linear", colors: colors }; gradOpt(g, opt); return g; }
function RadialGradient(colors, opt) { let g = { type: "radial", colors: colors }; gradOpt(g, opt); return g; }
function gradOpt(g, opt) {
    if (isNull(opt)) { return 0; } if (opt == 0) { return 0; }
    if (has(opt, "stops")) { g.stops = opt.stops; }
    if (has(opt, "begin")) { g.begin = opt.begin; }
    if (has(opt, "end")) { g.end = opt.end; }
    return 0;
}

// ---- host entry points -------------------------------------------------------
function onEvent(e) { M.onEvent(e); }
function onFrame(dt) { M.onFrame(dt); }
function onResize(info) { M.onResize(info); }
