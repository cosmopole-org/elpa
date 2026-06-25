// Ambient declarations for the Game3D SDK and the Elpa runtime.
//
// The SDK is vendored as plain VM-subset JavaScript under `app/sdk/game3d` and
// linked ahead of your app by `create-elpa-app build`, so its functions are
// *global* at runtime — no import needed. These `declare`s give your editor the
// types; they emit nothing. (The build's shim turns idiomatic JS — template
// literals, `arr.map`, `Math.floor`, `a.length` — into the VM's stdlib globals,
// so write normal TypeScript.)

export {}; // make this a module so the project's imports resolve cleanly

declare global {
    type Color = number[]; // [r, g, b, a], 0..1
    type Vec3 = number[]; // [x, y, z]

    interface Material {
        color: Color;
        roughness: number;
        metallic: number;
        doubleSided: number;
    }
    interface Object3D {
        children: Object3D[];
        add(child: Object3D): void;
        rotateY(radians: number): void;
        setPosition(x: number, y: number, z: number): void;
    }
    interface Mesh extends Object3D {
        material: Material;
    }
    interface Group extends Object3D {}
    interface Scene {
        add(obj: Object3D): void;
        setBackground(color: Color): void;
    }
    interface Game {
        time: number;
    }
    interface Panel {
        label(text: string | ((g: Game) => string)): Panel;
        bar(label: string, value: (g: Game) => number, color: Color): Panel;
        button(label: string, onTap: (g: Game) => void): Panel;
    }
    interface Overlay {
        theme: Record<string, Color>;
        visible: number;
    }

    // scene graph
    function createScene(): Scene;
    function group(): Group;
    function v3(x: number, y: number, z: number): Vec3;
    function directionalLight(color: Color, intensity: number, dir: Vec3): Object3D;
    function boxMesh(w: number, h: number, d: number, opts?: Partial<Material>): Mesh;
    function sphereMesh(r: number, opts?: Partial<Material>): Mesh;
    function cylinderMesh(rt: number, rb: number, h: number, seg: number, opts?: Partial<Material>): Mesh;

    // runtime / camera / HUD
    function useScene(scene: Scene): void;
    function enableOrbit(opts: {
        target: Vec3;
        distance: number;
        minDistance: number;
        maxDistance: number;
        yaw: number;
        pitch: number;
    }): void;
    function overlay(): Overlay;
    function addPanel(opts: { id: string; title: string; x: number; y: number; w: number; collapsed?: number }): Panel;
    function onUpdate(cb: (dt: number, g: Game) => number): void;
    function startGame(): void;
}
