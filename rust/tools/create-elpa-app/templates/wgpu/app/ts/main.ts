// __APP_TITLE__ — entry point.
//
// Wires the 3D scene (scene.ts) and the Material-styled HUD (hud.ts) to the
// shared simulation (sim.ts), then drives the per-frame update. Game3D owns the
// wgpu surface; the HUD is composited over the 3D image in the same frame.

import { Sim } from "./sim";
import { buildScene } from "./scene";
import { buildHud } from "./hud";

const APP_TITLE = "__APP_TITLE__";

const sim = new Sim();
const handles = buildScene(sim);
buildHud(sim, APP_TITLE);

// Each child of the ring is a pivot whose single child is an orbiting body.
const pivots = handles.ring.children;

onUpdate((dt, g) => {
    sim.tickFps(dt);
    if (sim.paused) {
        return 0;
    }
    const w = dt * sim.spin;
    handles.ring.rotateY(w * 0.4); // orbit the whole ring
    pivots.forEach((pivot) => {
        pivot.children[0].rotateY(w * 1.6); // spin each body
    });
    handles.pillar.rotateY(w * 0.8);
    return 0;
});

startGame();
