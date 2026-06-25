// The 3D scene: a cube rendered by Elpa's wgpu pipeline into the Native3DView
// surface. The geometry is registered once as a render-level GPU definition; each
// frame submits a surface pass that clears to an animated background and draws the
// cube. This drives the GPU pipe directly (app.gpu) so it runs on the VM with no
// host-specific helpers — extend prime()/render() with your own meshes/pipelines.

import { app } from "./app";

// The 8 corners of a cube (position only) and the 36 triangle indices.
const CUBE_VERTS = [
    -0.8, -0.8, -0.8, 0.8, -0.8, -0.8, 0.8, 0.8, -0.8, -0.8, 0.8, -0.8,
    -0.8, -0.8, 0.8, 0.8, -0.8, 0.8, 0.8, 0.8, 0.8, -0.8, 0.8, 0.8,
];
const CUBE_INDICES = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 4, 5, 1, 4, 1, 0,
    3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 4, 0, 3, 4, 3, 7,
];

export class SceneController {
    gpu = app.gpu;
    angle = 0.0;
    spinning = true;
    primed = false;

    /// Register the cube geometry once (referenced by id every frame thereafter).
    prime(): void {
        this.gpu.define({
            id: "cube",
            level: "render",
            resources: [
                { kind: "buffer", id: "cube.vb", usage: "vertex", dataF32: CUBE_VERTS },
                { kind: "buffer", id: "cube.ib", usage: "index", dataU16: CUBE_INDICES },
            ],
            commands: [
                { cmd: "setPipeline", pipeline: "elpa.pbr" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "cube.vb" },
                { cmd: "setIndexBuffer", buffer: "cube.ib", format: "uint16" },
                { cmd: "drawIndexed", indexCount: CUBE_INDICES.length },
            ],
        });
        this.primed = true;
    }

    render(dt: number): void {
        if (!this.primed) {
            this.prime();
        }
        if (this.spinning) {
            this.angle += dt * 0.9;
        }
        // Animate the clear colour so the native surface is visibly alive even
        // before a full 3D pipeline is wired up.
        const t = (Math.sin(this.angle) + 1.0) * 0.5;
        const bg = Color.rgba(0.05 + t * 0.1, 0.09, 0.16 + t * 0.1, 1.0);
        this.gpu.frame().surfacePass(bg, [{ cmd: "useDefinition", definition: "cube" }]).submit();
    }
}

export const sceneCtl = new SceneController();
