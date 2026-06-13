# Elpa

A Rust + **wgpu** universal, high-performance app framework for **web, mobile, and
desktop**. You write your app in **JavaScript**; Elpa compiles it to an AST,
runs it on an embedded Rust VM, and renders the UI on the GPU with **partial
rendering** — only the rectangles that actually changed are redrawn, everything
else is composited from cached GPU-texture layers.

> **The full design lives in [`PLAN.md`](./PLAN.md).** Start there.

## How it works (one breath)

```text
JavaScript ──▶ Elpian AST JSON ──▶ bytecode ──▶ VM (your app logic)
                                                   │ askHost("render", uiTree)
                                                   ▼
                       UiTree ──▶ layout + lower ──▶ DrawList
                                                   │
                       drawing manager (layer cache + dirty rects)
                                                   │
                                            wgpu backend ──▶ GPU
```

The VM never knows about wgpu; the renderer never knows about the VM. They agree
only on the shared types in `elpa-protocol`.

## Workspace

| Crate | Role | Status |
|-------|------|--------|
| `elpian-vm` | Ported Elpian AST bytecode VM + embedding/host-call API | ✅ running |
| `elpa-protocol` | Shared types: `UiTree`, `DrawList`, geometry, host-call envelope | ✅ tested |
| `elpa-renderer` | Drawing-management layer (layer cache, dirty rects, partial render) + `GpuBackend` trait | ✅ logic tested · 🔜 wgpu backend |
| `elpa-runtime` | Host-call dispatch loop: drives the VM, routes `render` + events | ✅ tested |

## Build & test

```bash
cargo build --workspace
cargo test  --workspace
```

The test suite proves the partial-rendering behavior end to end:
- the ported VM compiles an AST, runs it, and emits a `render` UI tree;
- a steady-state frame re-rasterizes **zero** layers and presents **nothing**;
- changing one of several layers re-rasterizes **exactly one**.

## Status

Milestone **M0 (Foundation)** is complete. Next up: layout & lowering (M1), text
& resources (M2), and the wgpu backend (M3). See [`PLAN.md` §17](./PLAN.md#17-roadmap--milestones).

## Provenance

The VM under `crates/elpian-vm/src/sdk` is ported from the
[Elpian](https://github.com/cosmopole-org/elpian) project's Rust VM, re-homed
behind a renderer-agnostic API (the original Bevy/Flutter coupling was removed).
