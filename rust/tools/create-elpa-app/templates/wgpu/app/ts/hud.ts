// The Material-styled 2D HUD, composited over the 3D scene in the renderer's
// second (alpha-blended) pass. Floating panels with live read-outs and buttons.

import { M3_THEME, M3_PRIMARY } from "./theme";
import { Sim } from "./sim";

export function buildHud(sim: Sim, title: string): void {
    // Restyle the overlay with the Material Design 3 palette.
    overlay().theme = M3_THEME;

    addPanel({ id: "stats", title, x: 16.0, y: 16.0, w: 220.0 })
        .label((g) => `FPS     ${Math.floor(sim.fps)}`)
        .label(() => `BODIES  ${sim.bodies.length}`)
        .label((g) => `CLOCK   ${Math.floor(g.time)}S`)
        .bar("SPIN", () => sim.spin, M3_PRIMARY);

    addPanel({ id: "controls", title: "CONTROLS", x: 16.0, y: 168.0, w: 220.0 })
        .button("PAUSE / RESUME", () => {
            sim.paused = !sim.paused;
        })
        .button("SPIN FASTER", () => {
            sim.spin = Math.min(3.0, sim.spin + 0.35);
        })
        .button("SPIN SLOWER", () => {
            sim.spin = Math.max(0.0, sim.spin - 0.35);
        })
        .button("RECOLOR", () => {
            sim.recolor();
        });

    addPanel({ id: "help", title: "HELP", x: 16.0, y: 360.0, w: 220.0, collapsed: 1.0 })
        .label("DRAG SCENE: ORBIT")
        .label("WHEEL / PINCH: ZOOM")
        .label("DRAG TITLE: MOVE PANEL");
}
