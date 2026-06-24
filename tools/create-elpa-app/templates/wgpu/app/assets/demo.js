// __APP_TITLE__ — Elpa wgpu demo: a 3D scene with a 2D UI overlay.
//
// This program is authored against the Game3D SDK (concatenated ahead of it by
// build.rs). It builds a small lit 3D scene — a ground disc and a ring of
// orbiting, spinning primitives — and a 2D heads-up UI (the SDK's overlay
// panels: live read-outs and buttons) composited on top. Drag to orbit the
// camera, scroll to zoom; the buttons drive the simulation.
//
// The Material SDK is also vendored (../assets/sdk/material) if you'd rather
// build a pure 2D Elpa app; see the project README.

// ---- live simulation state, shared by the update loop and the UI buttons -----
let sim = { fps: 60.0, paused: 0.0, spin: 1.0, hue: 0.0 };

// A small, pleasant palette the "RECOLOR" button cycles the orbiting bodies through.
let PALETTE = [
    [0.92, 0.36, 0.38, 1.0],
    [0.36, 0.62, 0.92, 1.0],
    [0.40, 0.80, 0.52, 1.0],
    [0.95, 0.74, 0.28, 1.0],
    [0.74, 0.50, 0.92, 1.0],
];

// ---- build the scene ---------------------------------------------------------
let scene = createScene();
scene.setBackground([0.06, 0.07, 0.10, 1.0]);

// Two directional lights: a warm key and a cool fill, so the primitives read in 3D.
scene.add(directionalLight([1.0, 0.95, 0.85], 1.15, v3(-0.4, -1.0, -0.35)));
scene.add(directionalLight([0.45, 0.58, 0.85], 0.45, v3(0.5, -0.25, 0.6)));

// A ground disc to anchor the scene.
let ground = cylinderMesh(7.0, 7.0, 0.4, 48, { color: [0.16, 0.18, 0.22, 1.0], roughness: 0.95 });
ground.setPosition(0.0, -1.2, 0.0);
scene.add(ground);

// A ring of orbiting bodies. Each is parented to its own pivot group so the loop
// can spin the whole ring and each body about its own axis cheaply.
let ring = group();
scene.add(ring);

let BODIES = 7;
let bodies = [];
for (let i = 0; i < BODIES; i++) {
    let a = (i / BODIES) * 6.2831853;
    let col = PALETTE[i % len(PALETTE)];
    // Alternate cubes and spheres around the ring.
    let m = (i % 2 == 0)
        ? boxMesh(0.9, 0.9, 0.9, { color: col, roughness: 0.5, metallic: 0.1 })
        : sphereMesh(0.6, { color: col, roughness: 0.4, metallic: 0.15 });
    let pivot = group();
    m.setPosition(3.4, 0.0, 0.0);
    pivot.rotateY(a);
    pivot.add(m);
    ring.add(pivot);
    push(bodies, { mesh: m, base: col });
}

// A taller centrepiece so there is something at the middle of the ring.
let pillar = cylinderMesh(0.5, 0.7, 2.2, 24, { color: [0.85, 0.85, 0.9, 1.0], roughness: 0.3, metallic: 0.4 });
pillar.setPosition(0.0, 0.1, 0.0);
scene.add(pillar);

useScene(scene);

// A turntable camera rig: drag to orbit, wheel/pinch to zoom.
enableOrbit({ target: v3(0.0, 0.0, 0.0), distance: 12.0, minDistance: 5.0, maxDistance: 24.0, yaw: 0.7, pitch: 0.45 });

// ---- the 2D UI overlay -------------------------------------------------------
// Floating panels with live read-outs and buttons, drawn over the 3D scene.
addPanel({ id: "stats", title: "__APP_TITLE__", x: 16.0, y: 16.0, w: 220.0 })
    .label((g) => { return concat("FPS     ", str(floor(sim.fps))); })
    .label((g) => { return concat("BODIES  ", str(BODIES)); })
    .label((g) => { return concat("CLOCK   ", concat(str(floor(g.time)), "S")); })
    .bar("SPIN", (g) => { return sim.spin; }, [0.45, 0.78, 1.0, 1.0]);

addPanel({ id: "controls", title: "CONTROLS", x: 16.0, y: 168.0, w: 220.0 })
    .button("PAUSE / RESUME", (g) => { if (sim.paused > 0.5) { sim.paused = 0.0; } else { sim.paused = 1.0; } })
    .button("SPIN FASTER", (g) => { sim.spin = sim.spin + 0.35; if (sim.spin > 3.0) { sim.spin = 3.0; } })
    .button("SPIN SLOWER", (g) => { sim.spin = sim.spin - 0.35; if (sim.spin < 0.0) { sim.spin = 0.0; } })
    .button("RECOLOR", (g) => { recolor(); });

addPanel({ id: "help", title: "HELP", x: 16.0, y: 360.0, w: 220.0, collapsed: 1.0 })
    .label("DRAG SCENE: ORBIT")
    .label("WHEEL / PINCH: ZOOM")
    .label("DRAG TITLE: MOVE PANEL");

// Step the palette and retint every body.
function recolor() {
    sim.hue = sim.hue + 1.0;
    let shift = floor(sim.hue);
    for (let i = 0; i < len(bodies); i++) {
        let col = PALETTE[(i + shift) % len(PALETTE)];
        bodies[i].mesh.material.color = col;
    }
}

// ---- the update loop ---------------------------------------------------------
let pivots = ring.children;
onUpdate((dt, g) => {
    // Smooth the frame rate for a steady read-out.
    if (dt > 0.0001) { sim.fps = sim.fps * 0.9 + (1.0 / dt) * 0.1; }
    if (sim.paused > 0.5) { return 0; }
    let w = dt * sim.spin;
    ring.rotateY(w * 0.4);            // orbit the whole ring
    for (let i = 0; i < len(pivots); i++) {
        pivots[i].children[0].rotateY(w * 1.6);  // spin each body
    }
    pillar.rotateY(w * 0.8);
    return 0;
});

startGame();
