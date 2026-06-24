// Elpa Game3D — lights.
//
// Lights are `Object3D`s so they live in the scene graph and inherit a parent's
// transform (a torch parented to a hand, a sun parented to a day-cycle pivot).
// The renderer collects them during traversal and packs each into the fixed-size
// light array of the scene uniform; the WGSL forward shader then accumulates a
// Blinn-Phong contribution per light, with distance attenuation for point lights.
//
// Each light encodes to three vec4s (matching `Light` in the shader):
//   posdir = (x, y, z, kind)        kind: 0 = directional, 1 = point
//   color  = (r, g, b, intensity)
//   params = (range, 0, 0, 0)       range: point-light falloff distance
// For a directional light xyz is the direction the light travels *toward* the
// scene; for a point light xyz is its world-space position.

let LIGHT_DIRECTIONAL = 0.0;
let LIGHT_POINT = 1.0;

// The hard cap on simultaneous lights — must equal `MAX_LIGHTS` in the shader.
let MAX_LIGHTS = 8;
// Floats per packed light (three vec4s).
let LIGHT_STRIDE = 12;

class Light extends Object3D {
    constructor(color, intensity) {
        super();
        this.nodeType = "light";
        if (isNull(color)) { color = [1.0, 1.0, 1.0]; }
        if (isNull(intensity)) { intensity = 1.0; }
        this.color = color;
        this.intensity = intensity;
        this.lightKind = LIGHT_DIRECTIONAL;
        this.range = 0.0;
    }
    setColor(c) { this.color = c; return this; }
    setIntensity(i) { this.intensity = i; return this; }
    // Pack into the 12 floats the scene uniform expects. Overridden per subtype.
    pack() {
        return [0.0, 0.0, 0.0, this.lightKind,
            this.color[0], this.color[1], this.color[2], this.intensity,
            this.range, 0.0, 0.0, 0.0];
    }
}

// A directional (sun) light. `dir` is the direction the light travels toward the
// scene; the shader negates it to get the surface-to-light vector.
class DirectionalLight extends Light {
    constructor(color, intensity, dir) {
        super(color, intensity);
        this.lightKind = LIGHT_DIRECTIONAL;
        if (isNull(dir)) { dir = new Vec3(-0.4, -1.0, -0.3); }
        this.direction = dir.normalize();
    }
    setDirection(d) { this.direction = d.normalize(); return this; }
    pack() {
        let d = this.direction;
        return [d.x, d.y, d.z, LIGHT_DIRECTIONAL,
            this.color[0], this.color[1], this.color[2], this.intensity,
            0.0, 0.0, 0.0, 0.0];
    }
}

// A point light at the node's world position, attenuated within `range`.
class PointLight extends Light {
    constructor(color, intensity, rng) {
        super(color, intensity);
        this.lightKind = LIGHT_POINT;
        if (isNull(rng)) { rng = 12.0; }
        this.range = rng;
    }
    setRange(r) { this.range = r; return this; }
    pack() {
        let p = this.worldPosition();
        return [p.x, p.y, p.z, LIGHT_POINT,
            this.color[0], this.color[1], this.color[2], this.intensity,
            this.range, 0.0, 0.0, 0.0];
    }
}
