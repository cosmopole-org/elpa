// The live simulation state, shared by the update loop and the HUD buttons.

import { PALETTE } from "./theme";

export interface Body {
    mesh: Mesh;
    base: Color;
}

export class Sim {
    fps: number = 60.0;
    paused: boolean = false;
    spin: number = 1.0;
    hue: number = 0.0;
    bodies: Body[] = [];

    /// Smooth the measured frame rate for a steady read-out.
    tickFps(dt: number): void {
        if (dt > 0.0001) {
            this.fps = this.fps * 0.9 + (1.0 / dt) * 0.1;
        }
    }

    /// Step the palette and retint every orbiting body.
    recolor(): void {
        this.hue += 1.0;
        const shift = Math.floor(this.hue);
        this.bodies.forEach((b, i) => {
            b.mesh.material.color = PALETTE[(i + shift) % PALETTE.length];
        });
    }
}
