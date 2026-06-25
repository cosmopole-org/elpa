// Build the 3D scene: a ground disc, a ring of orbiting cubes/spheres, and a
// centre pillar. Game3D owns the wgpu surface and renders this lit scene; the
// HUD (see hud.ts) is composited over it in the same frame.

import { PALETTE } from "./theme";
import { Sim } from "./sim";

export interface SceneHandles {
    ring: Group;
    pillar: Mesh;
}

const BODIES = 7;

export function buildScene(sim: Sim): SceneHandles {
    const scene = createScene();
    scene.setBackground([0.06, 0.07, 0.1, 1.0]);

    // A warm key light and a cool fill, so the primitives read in 3D.
    scene.add(directionalLight([1.0, 0.95, 0.85], 1.15, v3(-0.4, -1.0, -0.35)));
    scene.add(directionalLight([0.45, 0.58, 0.85], 0.45, v3(0.5, -0.25, 0.6)));

    // A ground disc to anchor the scene.
    const ground = cylinderMesh(7.0, 7.0, 0.4, 48, { color: [0.16, 0.18, 0.22, 1.0], roughness: 0.95 });
    ground.setPosition(0.0, -1.2, 0.0);
    scene.add(ground);

    // A ring of orbiting bodies, each parented to its own pivot group so the loop
    // can spin the whole ring and each body about its own axis cheaply.
    const ring = group();
    scene.add(ring);
    for (let i = 0; i < BODIES; i++) {
        const angle = (i / BODIES) * Math.PI * 2;
        const col = PALETTE[i % PALETTE.length];
        // Alternate cubes and spheres around the ring.
        const mesh =
            i % 2 === 0
                ? boxMesh(0.9, 0.9, 0.9, { color: col, roughness: 0.5, metallic: 0.1 })
                : sphereMesh(0.6, { color: col, roughness: 0.4, metallic: 0.15 });
        const pivot = group();
        mesh.setPosition(3.4, 0.0, 0.0);
        pivot.rotateY(angle);
        pivot.add(mesh);
        ring.add(pivot);
        sim.bodies.push({ mesh, base: col });
    }

    // A taller centrepiece at the middle of the ring.
    const pillar = cylinderMesh(0.5, 0.7, 2.2, 24, { color: [0.85, 0.85, 0.9, 1.0], roughness: 0.3, metallic: 0.4 });
    pillar.setPosition(0.0, 0.1, 0.0);
    scene.add(pillar);

    useScene(scene);
    // A turntable camera rig: drag to orbit, wheel/pinch to zoom.
    enableOrbit({ target: v3(0.0, 0.0, 0.0), distance: 12.0, minDistance: 5.0, maxDistance: 24.0, yaw: 0.7, pitch: 0.45 });

    return { ring, pillar };
}
