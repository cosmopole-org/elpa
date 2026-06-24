// Elpa Game3D — demo: a low-poly island village.
//
// A real little scene rather than a couple of primitives: a round grass island
// ringed by a sandy beach in an open sea, a cluster of cottages with roofs,
// windows and chimneys, scattered trees, gentle hills, a working windmill whose
// sails turn, sailboats bobbing offshore, villagers hopping about and clouds
// drifting overhead — all lit by a warm sun and a cool sky fill. In the square,
// two pedestals display gems **loaded at runtime through the SDK's glTF/GLB
// loader** (one base64 `.glb`, one `.gltf` JSON with a `data:` buffer), so the
// loader path runs on the live GPU and not only in the headless tests.
//
// Everything else is assembled from the SDK's primitives sharing a handful of cached
// geometries (one box, one pyramid, one cone, one cylinder, one sphere) reused
// across ~100 meshes via per-node transforms, so the whole village costs only a
// few vertex buffers. The camera is a turntable rig: **drag to orbit, scroll /
// pinch to zoom, right-drag to pan**.
//
// The scene is assembled through small builder functions (rather than one giant
// top-level block) — both for clarity and because the VM bounds the size of any
// single scope.

let WATER_Y = -0.55;

// Live HUD / simulation state, shared between the panel callbacks and the update
// loop: a smoothed frame rate, a pause flag and a clouds-visible flag the buttons
// flip and the loop reads.
let sim = { fps: 60.0, paused: 0.0, clouds: 1.0 };

// ---- shared assets: cached geometries + materials, reused by every mesh ------
function buildGeometries(A) {
    A.gBox = boxGeometry(1.0, 1.0, 1.0);
    A.gPyramid = coneGeometry(0.72, 1.0, 4);     // 4-sided → a roof
    A.gCone = coneGeometry(0.7, 1.0, 9);         // tree foliage / round cap
    A.gTrunk = cylinderGeometry(0.12, 0.16, 1.0, 6);
    A.gTower = cylinderGeometry(0.7, 1.0, 1.0, 12);
    A.gDisc = cylinderGeometry(1.0, 1.0, 1.0, 36); // flat discs (island, beach)
    A.gSphere = sphereGeometry(1.0, 12, 18);
    A.gDome = sphereGeometry(1.0, 10, 16);
}
function buildMaterials(A) {
    A.grass = material({ color: [0.36, 0.62, 0.30, 1.0], roughness: 0.95 });
    A.grassDark = material({ color: [0.30, 0.54, 0.26, 1.0], roughness: 0.95 });
    A.sand = material({ color: [0.86, 0.78, 0.55, 1.0], roughness: 1.0 });
    A.water = material({ color: [0.18, 0.46, 0.74, 1.0], roughness: 0.25, metallic: 0.15 });
    A.trunk = material({ color: [0.43, 0.29, 0.18, 1.0], roughness: 0.9 });
    A.leaf = material({ color: [0.20, 0.52, 0.27, 1.0], roughness: 0.85 });
    A.leaf2 = material({ color: [0.16, 0.44, 0.22, 1.0], roughness: 0.85 });
    A.roof = material({ color: [0.74, 0.28, 0.24, 1.0], roughness: 0.8 });
    A.roof2 = material({ color: [0.52, 0.38, 0.30, 1.0], roughness: 0.85 });
    A.door = material({ color: [0.39, 0.25, 0.16, 1.0], roughness: 0.8 });
    A.win = material({ color: [0.20, 0.18, 0.12, 1.0], emissive: [1.0, 0.82, 0.42], emissiveIntensity: 0.9 });
    A.stone = material({ color: [0.82, 0.82, 0.84, 1.0], roughness: 0.7 });
    A.blade = material({ color: [0.93, 0.90, 0.84, 1.0], roughness: 0.7 });
    A.cloud = material({ color: [0.97, 0.98, 1.0, 1.0], roughness: 1.0 });
    A.boat = material({ color: [0.52, 0.33, 0.20, 1.0], roughness: 0.85 });
    A.sail = material({ color: [0.95, 0.95, 0.92, 1.0], roughness: 0.9 });
    A.skin = material({ color: [0.86, 0.66, 0.52, 1.0], roughness: 0.8 });
    A.shirts = [
        material({ color: [0.82, 0.30, 0.32, 1.0], roughness: 0.8 }),
        material({ color: [0.28, 0.46, 0.74, 1.0], roughness: 0.8 }),
        material({ color: [0.86, 0.70, 0.26, 1.0], roughness: 0.8 })];
    A.walls = [
        material({ color: [0.92, 0.86, 0.74, 1.0], roughness: 0.9 }),
        material({ color: [0.86, 0.80, 0.70, 1.0], roughness: 0.9 }),
        material({ color: [0.80, 0.73, 0.62, 1.0], roughness: 0.9 })];
}
function assets() { let A = {}; buildGeometries(A); buildMaterials(A); return A; }

// ---- builders ----------------------------------------------------------------
// A tree: a trunk and two stacked foliage cones, scaled by `s`.
function makeTree(A, x, z, s) {
    let g = group();
    let trunk = mesh(A.gTrunk, A.trunk);
    trunk.setScale(s, s * 1.5, s); trunk.setPosition(0.0, s * 0.75, 0.0); g.add(trunk);
    let f1 = mesh(A.gCone, A.leaf); f1.setScale(s * 1.7, s * 2.0, s * 1.7); f1.setPosition(0.0, s * 2.0, 0.0); g.add(f1);
    let f2 = mesh(A.gCone, A.leaf2); f2.setScale(s * 1.25, s * 1.6, s * 1.25); f2.setPosition(0.0, s * 2.9, 0.0); g.add(f2);
    g.setPosition(x, 0.0, z);
    return g;
}

// A cottage: walls, a pyramid roof, a door, two glowing windows and a chimney.
function makeHouse(A, x, z, ry, wallMat, rMat) {
    let g = group();
    let body = mesh(A.gBox, wallMat); body.setScale(2.2, 1.4, 2.6); body.setPosition(0.0, 0.7, 0.0); g.add(body);
    let roof = mesh(A.gPyramid, rMat); roof.setScale(2.4, 1.35, 2.4); roof.setPosition(0.0, 2.05, 0.0); roof.rotateY(0.7853982); g.add(roof);
    let door = mesh(A.gBox, A.door); door.setScale(0.55, 0.85, 0.12); door.setPosition(0.0, 0.43, 1.31); g.add(door);
    let winL = mesh(A.gBox, A.win); winL.setScale(0.5, 0.5, 0.1); winL.setPosition(-0.72, 0.85, 1.31); g.add(winL);
    let winR = mesh(A.gBox, A.win); winR.setScale(0.5, 0.5, 0.1); winR.setPosition(0.72, 0.85, 1.31); g.add(winR);
    let chimney = mesh(A.gBox, A.stone); chimney.setScale(0.32, 0.8, 0.32); chimney.setPosition(0.6, 2.3, -0.5); g.add(chimney);
    g.setPosition(x, 0.0, z); g.rotateY(ry);
    return g;
}

// A windmill: a tapered tower, a round cap and four sails on a hub that turns.
// Returns { root, hub } so the animation loop can spin the hub.
function makeWindmill(A, x, z) {
    let g = group();
    let tower = mesh(A.gTower, A.stone); tower.setScale(1.0, 3.6, 1.0); tower.setPosition(0.0, 1.8, 0.0); g.add(tower);
    let cap = mesh(A.gCone, A.roof2); cap.setScale(1.2, 1.3, 1.2); cap.setPosition(0.0, 4.2, 0.0); g.add(cap);
    let hub = group(); hub.setPosition(0.0, 2.8, 1.05);
    for (let k = 0; k < 4; k++) {
        let arm = group(); arm.rotateZ(k * 1.5707963);
        let blade = mesh(A.gBox, A.blade); blade.setScale(0.18, 2.3, 0.06); blade.setPosition(0.0, 1.15, 0.0); arm.add(blade);
        hub.add(arm);
    }
    g.add(hub); g.setPosition(x, 0.0, z);
    return { root: g, hub: hub };
}

// A sailboat: hull + mast + sail (placed at the water line).
function makeBoat(A, x, z, ry) {
    let g = group();
    let hull = mesh(A.gBox, A.boat); hull.setScale(1.7, 0.45, 0.8); hull.setPosition(0.0, 0.18, 0.0); g.add(hull);
    let mast = mesh(A.gBox, A.trunk); mast.setScale(0.08, 1.5, 0.08); mast.setPosition(0.1, 1.0, 0.0); g.add(mast);
    let sail = mesh(A.gBox, A.sail); sail.setScale(0.05, 0.95, 0.62); sail.setPosition(0.12, 1.05, 0.0); g.add(sail);
    g.setPosition(x, WATER_Y, z); g.rotateY(ry);
    return g;
}

// A blocky villager: a coloured body and a round head.
function makeVillager(A, x, z, shirt) {
    let g = group();
    let body = mesh(A.gBox, shirt); body.setScale(0.45, 0.7, 0.32); body.setPosition(0.0, 0.55, 0.0); g.add(body);
    let head = mesh(A.gSphere, A.skin); head.setUniformScale(0.26); head.setPosition(0.0, 1.05, 0.0); g.add(head);
    g.setPosition(x, 0.0, z);
    return g;
}

// A small stone pedestal (a tapered plinth with a flat cap) for a display piece.
function makePedestal(A, x, z) {
    let g = group();
    let base = mesh(A.gTower, A.stone); base.setScale(0.55, 0.5, 0.55); base.setPosition(0.0, 0.25, 0.0); g.add(base);
    let cap = mesh(A.gBox, A.stone); cap.setScale(0.95, 0.18, 0.95); cap.setPosition(0.0, 0.6, 0.0); g.add(cap);
    g.setPosition(x, 0.0, z);
    return g;
}

// The village "shrine": two pedestals each displaying a model loaded at runtime
// through the SDK's glTF/GLB loader — proving both loader paths run on a live GPU,
// not just in the headless tests. The crystal comes from a base64 **.glb** binary
// container; the gold gem from a **.gltf** JSON document with a `data:` buffer.
// Returns the spinnable pivots (with their float heights) for the animation loop.
function buildShrine(scene, A) {
    scene.add(makePedestal(A, -1.7, -2.3));
    scene.add(makePedestal(A, 1.7, -2.3));

    let gemY = 1.55;
    let gem = group(); gem.setUniformScale(0.55); gem.setPosition(-1.7, gemY, -2.3);
    gem.add(loadGLBBase64(GEM_GLB_B64));          // .glb: 12-byte header + JSON + BIN
    scene.add(gem);

    let diaY = 1.6;
    let diamond = group(); diamond.setUniformScale(0.5); diamond.setPosition(1.7, diaY, -2.3);
    diamond.add(loadGLTF(diamondGLTF(), 0));       // .gltf: JSON doc + data: base64 buffer
    scene.add(diamond);

    return { gem: gem, diamond: diamond, gemY: gemY, diaY: diaY };
}

// A puffy cloud: three overlapping flattened spheres.
function makeCloud(A, x, y, z, s) {
    let g = group();
    let a = mesh(A.gSphere, A.cloud); a.setScale(s * 1.6, s * 0.8, s * 1.3); a.setPosition(-s * 0.9, 0.0, 0.0); g.add(a);
    let b = mesh(A.gSphere, A.cloud); b.setScale(s * 1.9, s * 1.0, s * 1.5); b.setPosition(0.0, s * 0.15, 0.0); g.add(b);
    let c = mesh(A.gSphere, A.cloud); c.setScale(s * 1.5, s * 0.8, s * 1.2); c.setPosition(s * 1.0, 0.0, 0.2); g.add(c);
    g.setPosition(x, y, z);
    return g;
}

// ---- HUD: floating, draggable panels over the scene --------------------------
// A little game UI composited on top of the 3D village: live read-outs (frame
// rate, scene size, clock), camera controls and simulation toggles, each in its
// own window the player can drag anywhere — by the title bar — with a mouse or a
// finger, and collapse via the title-bar grip. Rows take `fn(game)` callbacks for
// live values, so the panels track the running scene every frame.
function camZoomFrac(g) {
    let c = orbitControls(); if (c == 0) { return 0.0; }
    return (c.distance - c.minDistance) / (c.maxDistance - c.minDistance);
}
function resetView() {
    let c = orbitControls(); if (c == 0) { return 0; }
    c.distance = 30.0; c.yaw = 0.7; c.pitch = 0.5; c.target = v3(0.0, 1.2, 0.0); c.apply();
    return 0;
}
function setGroupVisible(g, on) {
    g.visible = on;
    for (let i = 0; i < len(g.children); i++) { g.children[i].visible = on; }
    return 0;
}
function toggleClouds(clouds) {
    if (sim.clouds > 0.5) { sim.clouds = 0.0; } else { sim.clouds = 1.0; }
    for (let i = 0; i < len(clouds); i++) { setGroupVisible(clouds[i], sim.clouds); }
    return 0;
}
function statusText() { if (sim.paused > 0.5) { return "PAUSED"; } return "RUNNING"; }
function cloudsText() { if (sim.clouds > 0.5) { return "CLOUDS ON"; } return "CLOUDS OFF"; }

function buildHud(clouds) {
    // Live village stats.
    addPanel({ id: "stats", title: "VILLAGE", x: 16.0, y: 16.0, w: 216.0 })
        .label((g) => { return concat("FPS    ", str(floor(sim.fps))); })
        .label((g) => { return concat("MESHES  ", str(g.renderer.stats.meshes)); })
        .label((g) => { return concat("DRAWS   ", str(g.renderer.stats.drawCalls)); })
        .label((g) => { return concat(concat("CLOCK   ", str(floor(g.time))), "S"); });

    // Camera read-out + touch-friendly controls.
    addPanel({ id: "camera", title: "CAMERA", x: 16.0, y: 188.0, w: 216.0 })
        .bar("ZOOM", (g) => { return camZoomFrac(g); }, [0.45, 0.78, 1.0, 1.0])
        .button("ZOOM IN", (g) => { orbitControls().zoomBy(0.85); })
        .button("ZOOM OUT", (g) => { orbitControls().zoomBy(1.18); })
        .button("RESET VIEW", (g) => { resetView(); });

    // Simulation toggles.
    addPanel({ id: "controls", title: "CONTROLS", x: 16.0, y: 408.0, w: 216.0 })
        .button("PAUSE / RESUME", (g) => { if (sim.paused > 0.5) { sim.paused = 0.0; } else { sim.paused = 1.0; } })
        .label((g) => { return concat("STATE   ", statusText()); })
        .button("TOGGLE CLOUDS", (g) => { toggleClouds(clouds); })
        .label((g) => { return cloudsText(); });

    // A short how-to, collapsed by default to stay out of the way.
    addPanel({ id: "help", title: "HELP", x: 16.0, y: 596.0, w: 216.0, collapsed: 1.0 })
        .label("DRAG TITLE: MOVE PANEL")
        .label("DRAG SCENE: ORBIT")
        .label("WHEEL / PINCH: ZOOM");
    return 0;
}

// ---- scene assembly (each section is its own scope) --------------------------
function buildLighting(scene) {
    scene.add(directionalLight([1.0, 0.96, 0.85], 1.15, v3(-0.45, -1.0, -0.35))); // warm sun
    scene.add(directionalLight([0.45, 0.58, 0.82, 1.0], 0.4, v3(0.5, -0.25, 0.6))); // cool sky fill
    let sunDisk = sphereMesh(1.0, { color: [1.0, 0.95, 0.8, 1.0], emissive: [1.0, 0.92, 0.7], emissiveIntensity: 4.0 });
    sunDisk.setUniformScale(3.0); sunDisk.setPosition(-26.0, 28.0, -34.0);
    scene.add(sunDisk);
}

function buildTerrain(scene, A) {
    let sea = planeMesh(260.0, { color: [0.18, 0.46, 0.74, 1.0], roughness: 0.25, metallic: 0.15 });
    sea.setPosition(0.0, WATER_Y, 0.0); scene.add(sea);
    let beach = mesh(A.gDisc, A.sand); beach.setScale(22.0, 0.5, 22.0); beach.setPosition(0.0, -0.45, 0.0); scene.add(beach);
    let island = mesh(A.gDisc, A.grass); island.setScale(19.5, 0.6, 19.5); island.setPosition(0.0, -0.3, 0.0); scene.add(island);
    let hillA = mesh(A.gDome, A.grassDark); hillA.setScale(6.0, 2.2, 6.0); hillA.setPosition(-9.0, -0.6, -8.0); scene.add(hillA);
    let hillB = mesh(A.gDome, A.grassDark); hillB.setScale(5.0, 1.8, 5.5); hillB.setPosition(9.0, -0.6, 9.0); scene.add(hillB);
}

// Returns the windmill hub (so the loop can spin it).
function buildVillage(scene, A) {
    let houses = [
        [-2.0, 2.0, 0.3, 0], [3.5, 3.5, -0.5, 1], [5.5, -2.0, 0.8, 2],
        [-4.5, -3.0, -0.4, 1], [0.5, 6.5, 0.1, 0], [-6.5, 4.5, 0.6, 2]];
    for (let i = 0; i < len(houses); i++) {
        let h = houses[i];
        let rm = A.roof; if (h[3] == 2) { rm = A.roof2; }
        scene.add(makeHouse(A, h[0], h[1], h[2], A.walls[h[3]], rm));
    }
    let mill = makeWindmill(A, 11.0, -5.0);
    scene.add(mill.root);
    return mill.hub;
}

function buildNature(scene, A) {
    let trees = [
        [-12.0, -8.0, 1.1], [-14.0, 2.0, 1.0], [-10.0, 10.0, 1.2], [-3.0, 12.0, 0.9],
        [6.0, 11.0, 1.1], [12.0, 7.0, 1.0], [14.0, -3.0, 1.2], [12.0, -11.0, 1.0],
        [3.0, -12.0, 1.1], [-7.0, -12.0, 0.9], [-13.5, -2.0, 1.0], [8.5, 1.5, 0.85]];
    for (let i = 0; i < len(trees); i++) { let t = trees[i]; scene.add(makeTree(A, t[0], t[1], t[2])); }
}

// Returns { boats, villagers, clouds } for the animation loop.
function buildLife(scene, A) {
    let boats = [makeBoat(A, 0.0, 26.0, 0.5), makeBoat(A, -22.0, 6.0, -1.1), makeBoat(A, 18.0, 20.0, 2.4)];
    for (let i = 0; i < len(boats); i++) { scene.add(boats[i]); }
    let villagers = [
        makeVillager(A, 1.0, 0.5, A.shirts[0]),
        makeVillager(A, -2.5, 5.0, A.shirts[1]),
        makeVillager(A, 4.0, -0.5, A.shirts[2])];
    for (let i = 0; i < len(villagers); i++) { scene.add(villagers[i]); }
    let clouds = [
        makeCloud(A, -10.0, 11.0, -8.0, 2.0), makeCloud(A, 7.0, 12.0, -12.0, 2.6),
        makeCloud(A, 14.0, 10.0, 5.0, 2.2), makeCloud(A, -14.0, 11.5, 9.0, 1.8)];
    for (let i = 0; i < len(clouds); i++) { scene.add(clouds[i]); }
    return { boats: boats, villagers: villagers, clouds: clouds };
}

// ---- top level: assemble, wire the camera, animate ---------------------------
let A = assets();
let scene = createScene();
scene.setBackground([0.53, 0.74, 0.93, 1.0]);   // open sky
scene.setAmbient([0.55, 0.66, 0.85], 0.42);      // soft sky bounce
buildLighting(scene);
buildTerrain(scene, A);
let millHub = buildVillage(scene, A);
buildNature(scene, A);
let shrine = buildShrine(scene, A);   // glTF/GLB models loaded onto pedestals
let life = buildLife(scene, A);
let boats = life.boats; let villagers = life.villagers; let clouds = life.clouds;
useScene(scene);

// A turntable camera rig (drag-orbit, wheel-zoom, right-drag-pan).
enableOrbit({ target: v3(0.0, 1.2, 0.0), distance: 30.0, minDistance: 8.0, maxDistance: 65.0, yaw: 0.7, pitch: 0.5 });

// Floating, draggable HUD panels composited over the scene.
buildHud(clouds);

onUpdate((dt, g) => {
    sim.fps = sim.fps * 0.92 + (1.0 / max(dt, 0.0001)) * 0.08;  // smoothed frame rate
    if (sim.paused > 0.5) { return 0; }        // "PAUSE" freezes the simulation
    let t = g.time;
    millHub.rotateZ(dt * 0.7);                 // the windmill sails turn
    shrine.gem.rotateY(dt * 0.9);              // the loaded GLB crystal spins
    shrine.gem.position.set(-1.7, shrine.gemY + sin(t * 1.6) * 0.08, -2.3);
    shrine.diamond.rotateY(dt * -0.7);         // the loaded glTF gem counter-spins
    shrine.diamond.position.set(1.7, shrine.diaY + sin(t * 1.6 + 1.6) * 0.08, -2.3);
    for (let i = 0; i < len(clouds); i++) {    // clouds drift east, wrapping
        let c = clouds[i]; let nx = c.position.x + dt * 0.6;
        if (nx > 26.0) { nx = -26.0; }
        c.position.set(nx, c.position.y, c.position.z);
    }
    for (let i = 0; i < len(boats); i++) {     // boats bob on the swell
        let b = boats[i]; let ph = num(i) * 1.7;
        b.position.set(b.position.x, WATER_Y + sin(t * 1.3 + ph) * 0.08, b.position.z);
    }
    for (let i = 0; i < len(villagers); i++) { // villagers hop and turn
        let v = villagers[i]; let ph = num(i) * 2.1;
        v.position.set(v.position.x, abs(sin(t * 2.2 + ph)) * 0.18, v.position.z);
        v.rotateY(dt * 0.5);
    }
});

startGame();
