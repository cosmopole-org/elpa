// Material Design 3 palette for the composited 2D HUD.
//
// Game3D's overlay exposes its shared colours as `overlay().theme`; assigning a
// new object restyles every panel. These are M3 (dark) roles — surface, primary,
// outline, on-surface, surface-variant — so the HUD reads as Material chrome over
// the 3D scene.

export const M3_THEME: Record<string, Color> = {
    body: [0.11, 0.106, 0.122, 0.92], // M3 surface
    title: [0.404, 0.314, 0.643, 0.98], // M3 primary (#6750A4)
    titleIdle: [0.18, 0.16, 0.26, 0.94], // dimmed primary
    border: [0.576, 0.561, 0.6, 0.4], // M3 outline
    text: [0.902, 0.882, 0.898, 1.0], // M3 on-surface
    dim: [0.79, 0.77, 0.81, 1.0], // M3 on-surface-variant
    track: [0.286, 0.271, 0.31, 1.0], // M3 surface-variant
    button: [0.404, 0.314, 0.643, 0.98], // M3 primary (filled button)
    grip: [0.816, 0.737, 1.0, 0.9], // M3 primary container accent
};

/// M3 primary, reused for the HUD gauges.
export const M3_PRIMARY: Color = [0.816, 0.737, 1.0, 1.0];

/// A pleasant palette the "RECOLOR" button cycles the orbiting bodies through.
export const PALETTE: Color[] = [
    [0.92, 0.36, 0.38, 1.0],
    [0.36, 0.62, 0.92, 1.0],
    [0.4, 0.8, 0.52, 1.0],
    [0.95, 0.74, 0.28, 1.0],
    [0.74, 0.5, 0.92, 1.0],
];
