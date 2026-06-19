// Elpa Game3D — demo application.
//
// Composes a small lit 3D scene with the SDK and animates it: a ground plane, a
// spinning metallic cube and a bobbing sphere under a directional "sun" and an
// orbiting point light, viewed by a slowly orbiting perspective camera. It uses
// the engine as a black box — build a scene graph, register an `onUpdate`
// callback, call `startGame()` — and never touches the GPU command tree. This is
// the program the web / native hosts load (compiled to bytecode at build time).

let scene = createScene();
scene.setBackground([0.03, 0.04, 0.07, 1.0]);
scene.setAmbient([0.55, 0.65, 0.95], 0.14);

// A warm key light from above and a cool moving fill light.
let sun = directionalLight([1.0, 0.96, 0.88], 1.15, v3(-0.5, -1.0, -0.35));
scene.add(sun);
let lamp = pointLight([0.4, 0.7, 1.0], 2.2, 11.0);
lamp.setPosition(3.0, 2.5, 3.0);
scene.add(lamp);

// A matte ground plane a unit below the origin.
let ground = planeMesh(24.0, { color: [0.16, 0.18, 0.22, 1.0], roughness: 0.95 });
ground.setPosition(0.0, -1.2, 0.0);
scene.add(ground);

// A glossy red cube on the left.
let cube = boxMesh(1.6, 1.6, 1.6, { color: [0.92, 0.32, 0.36, 1.0], metallic: 0.15, roughness: 0.35 });
cube.setPosition(-1.9, 0.0, 0.0);
scene.add(cube);

// A metallic green sphere on the right.
let ball = sphereMesh(1.05, { color: [0.32, 0.82, 0.55, 1.0], metallic: 0.7, roughness: 0.22 });
ball.setPosition(1.9, 0.0, 0.0);
scene.add(ball);

// A small emissive marker that follows the moving light.
let glow = sphereMesh(0.16, { color: [0.5, 0.8, 1.0, 1.0], emissive: [0.4, 0.7, 1.0], emissiveIntensity: 3.0 });
scene.add(glow);

let cam = perspectiveCamera(55.0, 0.1, 200.0);
cam.setPosition(7.5, 2.6, 0.0);
cam.lookAt(0.0, 0.0, 0.0);
useCamera(cam);
useScene(scene);

// Per-frame logic: spin the cube, bob the sphere, orbit the light and camera.
onUpdate((dt, g) => {
    let t = g.time;
    cube.rotateY(dt * 1.1);
    cube.rotateX(dt * 0.55);
    ball.setPosition(1.9, abs(sin(t * 1.6)) * 0.9, 0.0);
    let lx = cos(t) * 3.2; let lz = sin(t) * 3.2;
    lamp.setPosition(lx, 2.4, lz);
    glow.setPosition(lx, 2.4, lz);
    let r = 7.5;
    cam.setPosition(cos(t * 0.25) * r, 2.6, sin(t * 0.25) * r);
});

// Pointer picking: report the mesh under a tap (the engine casts the ray).
onInput((e, g) => {
    if (e.type == "pointerdown") {
        let hit = g.pick();
        // A full game would react to `hit.mesh`; the demo just exercises the path.
    }
});

startGame();
