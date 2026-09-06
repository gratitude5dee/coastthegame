import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// Spark boots its WASM at import time (fetch + instantiateStreaming), which Node cannot do; the painter only needs the
// SplatEdit / SplatEditSdf node contract, so mock that surface and test the stroke logic on plain Object3Ds.
vi.mock('@sparkjsdev/spark', () => {
  class SplatEditSdf extends THREE.Object3D {
    type: string;
    radius: number;
    color: THREE.Color;
    opacity: number;
    constructor(o: { type?: string; radius?: number; color?: THREE.Color; opacity?: number } = {}) {
      super();
      this.type = o.type ?? 'sphere';
      this.radius = o.radius ?? 1;
      this.color = o.color ?? new THREE.Color(1, 1, 1);
      this.opacity = o.opacity ?? 1;
    }
  }
  class SplatEdit extends THREE.Object3D {
    sdfs: SplatEditSdf[] | null;
    constructor(o: { name?: string; sdfs?: SplatEditSdf[] | null } = {}) {
      super();
      this.name = o.name ?? 'edit';
      this.sdfs = o.sdfs ?? null;
    }
    addSdf(s: SplatEditSdf) {
      this.sdfs ??= [];
      if (!this.sdfs.includes(s)) this.sdfs.push(s);
    }
    removeSdf(s: SplatEditSdf) {
      if (this.sdfs) this.sdfs = this.sdfs.filter((x) => x !== s);
    }
  }
  return { SplatEdit, SplatEditSdf, SplatEditSdfType: { SPHERE: 'sphere' }, SplatEditRgbaBlendMode: { SET_RGB: 'set_rgb' } };
});

import { SplatPainter } from '../../packages/engine/src/world/paint';

/** goal.md W-4: strokes, decimation, the per-cell SDF budget and undo — the parts that are not Spark's shader. */
describe('SplatPainter', () => {
  const pink = new THREE.Color(0xff3fa4);

  it('sprays puffs into one global edit, decimates dense points, and groups them into strokes', () => {
    const root = new THREE.Group();
    const p = new SplatPainter(root, { minSpacing: 0.1 });
    expect(root.children).toContain(p.edit);
    p.begin();
    expect(p.spray(new THREE.Vector3(0, 1, 0), pink)).toBeTruthy();
    expect(p.spray(new THREE.Vector3(0.02, 1, 0), pink)).toBeNull(); // too close to the last puff
    expect(p.spray(new THREE.Vector3(0.3, 1, 0), pink, 0.3)).toMatchObject({ r: 0.3, rgba: [pink.r, pink.g, pink.b, 1] });
    p.end();
    expect(p.count).toBe(2);
    expect(p.strokes).toHaveLength(1);
    expect(p.edit.sdfs![1]!.position.x).toBeCloseTo(0.3, 9);
    expect(p.edit.children).toHaveLength(2); // SDF nodes are children so their world matrices follow the group
  });

  it('undo pops the last stroke; clear empties everything', () => {
    const p = new SplatPainter(new THREE.Group(), { minSpacing: 0 });
    p.begin();
    p.spray(new THREE.Vector3(0, 0, 0), pink);
    p.spray(new THREE.Vector3(1, 0, 0), pink);
    p.end();
    p.begin();
    p.spray(new THREE.Vector3(2, 0, 0), pink);
    p.end();
    expect(p.count).toBe(3);
    expect(p.undo()).toBe(true);
    expect(p.count).toBe(2);
    expect(p.undo()).toBe(true);
    expect(p.count).toBe(0);
    expect(p.undo()).toBe(false);
    p.begin();
    p.spray(new THREE.Vector3(5, 0, 0), pink);
    p.clear();
    expect(p.count).toBe(0);
    expect(p.strokes).toHaveLength(0);
  });

  it('keeps at most maxSdfs puffs, dropping the oldest strokes first', () => {
    const p = new SplatPainter(new THREE.Group(), { minSpacing: 0, maxSdfs: 4 });
    for (let s = 0; s < 3; s++) {
      p.begin();
      p.spray(new THREE.Vector3(s, 0, 0), pink);
      p.spray(new THREE.Vector3(s, 1, 0), pink);
      p.end();
    }
    expect(p.count).toBe(4);
    expect(p.strokes).toHaveLength(2);
    expect(p.edit.sdfs![0]!.position.x).toBe(1); // stroke 0 fell off
  });
});
