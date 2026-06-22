// Elpa Material — media + chart widgets.
//
// Image and VideoPlayer (real network/storage sources decoded off-thread and
// shown as GPU textures via the second pipeline, with a styled placeholder until
// pixels land), plus Bar/Line/Pie/Sparkline charts drawn from the same rounded-
// rect primitive (the pie's wedges are radial spokes).

function pieColor(app, i) {
    let pal = [app.theme.acc(1.0), [0.0, 0.55, 0.55, 1.0], [0.85, 0.45, 0.1, 1.0], [0.45, 0.3, 0.7, 1.0], [0.2, 0.62, 0.28, 1.0], [0.82, 0.25, 0.35, 1.0]];
    return pal[i % len(pal)];
}
function fmtTime(frac) { return concat(str(floor(frac * 100.0)), "%"); }

class ImageWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 30.0; let h = m.u * 20.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = m.u * 1.2; if (has(p, "radius")) { r = p.radius * m.u; }
        let src = app.media.srcOf(p);
        if (src != 0) {
            // Kick off / poll the load. Only paint the real texture once it has
            // actually decoded; while it is still loading (or if it failed — a
            // network/CORS error) fall through to the styled placeholder rather
            // than stretching the 1x1 grey placeholder pixel into a blank box.
            let st = app.media.ensure(src.key, src.req, 0.0);
            if (st.ready > 0.5) {
                let tone = th.surfaceHighest(1.0);
                pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, tone, CLEAR);
                pnt.image(st.handle, cx, cy, hw, hh, r, WHITE);
                if (has(p, "label")) {
                    // A short scrim under the caption so white text stays legible
                    // over a bright photo.
                    pnt.rect(cx, cy + hh - m.u * 1.8, hw, m.u * 2.2, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.28], CLEAR);
                    app.font.text(pnt, p.label, cx, cy + hh - m.u * 2.0, m.cell("caption"), [1.0, 1.0, 1.0, 0.92]);
                }
                return 0;
            }
        }
        let tone = th.surfaceHighest(1.0); if (has(p, "color")) { tone = th.colorRole(p.color, 1.0); }
        pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, tone, CLEAR);
        pnt.rect(cx, cy - hh * 0.5, hw, hh * 0.5, r, 0.0, 0.0, th.brighten(tone, 0.04), CLEAR);
        app.icons.draw(pnt, "image", cx, cy, min(hw, hh) * 0.5, th.onSurface(0.35));
        if (has(p, "label")) { app.font.text(pnt, p.label, cx, cy + hh - m.u * 2.0, m.cell("caption"), th.onSurface(0.6)); }
    }
}
class VideoPlayerWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 60.0; let h = m.u * 34.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let playing = 0.0; if (has(p, "playing")) { playing = p.playing; }
        let val = 0.0; if (has(p, "value")) { val = p.value; }
        pnt.rect(cx, cy, hw, hh, m.u * 1.2, 0.0, 0.0, [0.05, 0.05, 0.07, 1.0], CLEAR);
        let src = app.media.srcOf(p);
        if (src != 0) {
            // Start / keep the stream loading; only blit a frame once one has
            // decoded. Until then the dark base above stands in (no grey box),
            // and a failed load simply leaves the styled player chrome.
            let st = app.media.ensure(src.key, src.req, 1.0);
            st._playing = playing;
            if (st.ready > 0.5) {
                pnt.image(st.handle, cx, cy, hw, hh, m.u * 1.2, WHITE);
                if (st.frames > 1) { val = st.curIdx / (st.frames - 1); }
            } else {
                pnt.rect(cx, cy - hh * 0.4, hw, hh * 0.6, m.u * 1.2, 0.0, 0.0, [0.1, 0.11, 0.14, 1.0], CLEAR);
            }
        } else {
            pnt.rect(cx, cy - hh * 0.4, hw, hh * 0.6, m.u * 1.2, 0.0, 0.0, [0.1, 0.11, 0.14, 1.0], CLEAR);
        }
        pnt.rect(cx, cy + hh - m.u * 2.6, hw, m.u * 2.6, m.u * 1.2, 0.0, 0.0, [0.0, 0.0, 0.0, 0.32], CLEAR);
        let cr = min(hw, hh) * 0.34;
        pnt.disc(cx, cy, cr, [0.0, 0.0, 0.0, 0.32]);
        pnt.disc(cx, cy, cr, [1.0, 1.0, 1.0, 0.16]);
        let ic = "play"; if (playing > 0.5) { ic = "pause"; }
        app.icons.draw(pnt, ic, cx, cy, cr * 0.7, [1.0, 1.0, 1.0, 0.95]);
        if (has(p, "onToggle")) { pnt.addTap(cx, cy, cr, cr, concat(p.id, "toggle"), p.onToggle); }
        let sy = cy + hh - m.u * 2.0; let sxl = cx - hw + m.u * 2.0; let sw = mz.w - m.u * 4.0;
        pnt.rect(cx, sy, sw / 2.0, m.u * 0.4, m.u * 0.4, 0.0, 0.0, [1.0, 1.0, 1.0, 0.3], CLEAR);
        pnt.rect(sxl + val * sw / 2.0, sy, val * sw / 2.0, m.u * 0.4, m.u * 0.4, 0.0, 0.0, th.acc(1.0), CLEAR);
        pnt.disc(sxl + val * sw, sy, m.u * 0.9, th.acc(1.0));
        if (has(p, "onSeek")) { pnt.addDrag(cx, sy, sw / 2.0, m.u * 2.5, p.onSeek, sxl, sw); }
        app.font.textLeft(pnt, fmtTime(val), sxl, sy - m.u * 2.3, m.cell("micro"), [1.0, 1.0, 1.0, 0.8]);
    }
}
class BarChartWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 60.0; let h = m.u * 28.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let data = p.data; let n = len(data); let maxv = 0.0;
        for (let i = 0; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } }
        if (has(p, "max")) { maxv = p.max; } if (maxv <= 0.0) { maxv = 1.0; }
        let pad = m.u * 1.0; let left = cx - hw + pad; let base = cy + hh - m.u * 3.0; let avail = mz.w - pad * 2.0;
        let step = avail / n; let bw = step * 0.6;
        let col = th.acc(1.0); if (has(p, "color")) { col = th.colorRole(p.color, 1.0); }
        pnt.rect(cx, base + m.u * 0.2, hw - pad, m.u * 0.06, 0.0, 0.0, 0.0, th.outlineVar(1.0), CLEAR);
        for (let i = 0; i < n; i++) {
            let h2 = (data[i] / maxv) * (mz.h - m.u * 7.0); if (h2 < m.u * 0.2) { h2 = m.u * 0.2; }
            let bcx = left + i * step + step / 2.0;
            pnt.rect(bcx, base - h2 / 2.0, bw / 2.0, h2 / 2.0, m.u * 0.4, 0.0, 0.0, col, CLEAR);
            if (has(p, "labels")) { app.font.text(pnt, p.labels[i], bcx, base + m.u * 1.6, m.cell("micro"), th.onSurface(0.7)); }
        }
    }
}
class LineChartWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 60.0; let h = m.u * 28.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let data = p.data; let n = len(data); if (n < 2) { return 0; }
        let maxv = data[0]; let minv = data[0];
        for (let i = 1; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } if (data[i] < minv) { minv = data[i]; } }
        if (has(p, "max")) { maxv = p.max; } if (has(p, "min")) { minv = p.min; }
        let rng = maxv - minv; if (rng <= 0.0) { rng = 1.0; }
        let pad = m.u * 2.0; let left = cx - hw + pad; let availW = mz.w - pad * 2.0; let top = cy - hh + pad; let availH = mz.h - pad * 2.0;
        let col = th.acc(1.0); if (has(p, "color")) { col = th.colorRole(p.color, 1.0); }
        pnt.rect(cx, cy + hh - pad, hw - pad, m.u * 0.05, 0.0, 0.0, 0.0, th.outlineVar(1.0), CLEAR);
        let pxs = []; let pys = [];
        for (let i = 0; i < n; i++) {
            let x = left + (num(i) / (n - 1)) * availW; let norm = (data[i] - minv) / rng; let y = top + (1.0 - norm) * availH;
            push(pxs, x); push(pys, y);
        }
        for (let i = 0; i < n - 1; i++) { pnt.seg(pxs[i], pys[i], pxs[i + 1], pys[i + 1], m.u * 0.4, col); }
        for (let i = 0; i < n; i++) { pnt.disc(pxs[i], pys[i], m.u * 0.55, col); }
    }
}
class SparklineWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 24.0; let h = m.u * 6.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let data = p.data; let n = len(data); if (n < 2) { return 0; }
        let maxv = data[0]; let minv = data[0];
        for (let i = 1; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } if (data[i] < minv) { minv = data[i]; } }
        let rng = maxv - minv; if (rng <= 0.0) { rng = 1.0; }
        let left = cx - hw; let top = cy - hh; let col = th.acc(1.0); if (has(p, "color")) { col = th.colorRole(p.color, 1.0); }
        let pxs = []; let pys = [];
        for (let i = 0; i < n; i++) { push(pxs, left + (num(i) / (n - 1)) * mz.w); push(pys, top + (1.0 - (data[i] - minv) / rng) * mz.h); }
        for (let i = 0; i < n - 1; i++) { pnt.seg(pxs[i], pys[i], pxs[i + 1], pys[i + 1], m.u * 0.3, col); }
    }
}
class PieChartWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.u * 14.0; if (has(this.p, "radius")) { r = this.p.radius * app.metrics.u; } return { w: r * 2.0, h: r * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let r = m.u * 14.0; if (has(p, "radius")) { r = p.radius * m.u; }
        let data = p.data; let n = len(data); let total = 0.0;
        for (let i = 0; i < n; i++) { total = total + data[i].value; }
        if (total <= 0.0) { total = 1.0; }
        let bounds = []; let acc = 0.0;
        for (let i = 0; i < n; i++) { acc = acc + data[i].value / total; push(bounds, acc); }
        let spokes = 72; let thick = (6.2832 * r / spokes) + m.u * 0.12;
        for (let s = 0; s < spokes; s++) {
            let frac = (num(s) + 0.5) / spokes; let si = 0;
            for (let j = 0; j < n; j++) { if (frac <= bounds[j]) { si = j; j = n; } }
            let aa = frac * 6.2832 - 1.5708; let col = pieColor(app, si);
            if (has(data[si], "colorIndex")) { col = pieColor(app, data[si].colorIndex); }
            pnt.seg(cx, cy, cx + cos(aa) * r, cy + sin(aa) * r, thick, col);
        }
        if (has(p, "hole")) { pnt.disc(cx, cy, r * p.hole, th.surfaceContainer(1.0)); }
    }
}
