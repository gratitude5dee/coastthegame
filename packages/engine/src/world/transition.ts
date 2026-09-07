/**
 * Transitions between cells (goal.md W-3, ADR-0009): until the kitbash street segments exist, a transition is a
 * procedural road from one cell's exit doorway to the neighbour's entry doorway — an asphalt strip with curbs (one
 * tilted box bridges the height difference), fog sprites over the seam, a **road cut** through whatever the cells'
 * ground grids have in the way (the grid is lowered to the road along the footprint; the splats above the road are
 * dissolved with an SDF box, W-4 "holes"), and a **gate** at the far end that stands until the neighbour's ground is
 * in the physics world. The geometry is pure (`corridorFrame`, `cutGroundForCorridor`) so it is unit-tested; the
 * three.js / Spark / Rapier parts are thin.
 */
import * as THREE from 'three';
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GroundGrid, PhysicsWorld, XZRect } from '../physics/world';
import type { Vec3 } from './level';

export interface CorridorFrame {
  a: Vec3;
  b: Vec3;
  width: number;
  /** Full length along the (tilted) road. */
  length: number;
  /** Horizontal length. */
  run: number;
  /** Rise from a to b (m). */
  rise: number;
  yaw: number;
  pitch: number;
  /** Unit horizontal direction from a to b. */
  dir: { x: number; z: number };
  /** Rotation that maps local +Z to the road's direction (and local +Y to the road's normal). */
  quaternion: THREE.Quaternion;
  /** Midpoint of the road surface. */
  mid: Vec3;
  /** XZ footprint, expanded by `margin` on every side. */
  footprint: XZRect;
  margin: number;
  /** Road surface height at a world XZ inside the footprint; null outside. */
  heightAt: (x: number, z: number) => number | null;
}

/** Road geometry from the exit doorway floor `a` to the entry doorway floor `b` (world space). */
export function corridorFrame(a: Vec3, b: Vec3, width = 6, margin = 1): CorridorFrame {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const run = Math.hypot(dx, dz);
  if (run < 1e-3) throw new Error('corridor endpoints coincide');
  const length = Math.hypot(run, dy);
  const dir = { x: dx / run, z: dz / run };
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.atan2(dy, run);
  const quaternion = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch));
  // The footprint is the bounding rectangle of both doorway floors grown by the road's half width + margin: a
  // straight road at any yaw fits inside; `heightAt` does the exact test.
  const half = width / 2 + margin;
  const footprint: XZRect = {
    minX: Math.min(a[0], b[0]) - half,
    maxX: Math.max(a[0], b[0]) + half,
    minZ: Math.min(a[2], b[2]) - half,
    maxZ: Math.max(a[2], b[2]) + half,
  };
  const heightAt = (x: number, z: number): number | null => {
    const px = x - a[0];
    const pz = z - a[2];
    const s = px * dir.x + pz * dir.z; // along the road
    const lateral = px * dir.z - pz * dir.x;
    if (s < -margin || s > run + margin || Math.abs(lateral) > width / 2 + margin) return null;
    const t = Math.min(1, Math.max(0, s / run));
    return a[1] + dy * t;
  };
  return {
    a,
    b,
    width,
    length,
    run,
    rise: dy,
    yaw,
    pitch,
    dir,
    quaternion,
    mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    footprint,
    margin,
    heightAt,
  };
}

/**
 * Lowers every grid vertex inside the corridor's footprint that stands above the road to `clearance` m below it —
 * the road cut — so the cell's own ground never blocks the road. Returns how many vertices moved. Vertices below
 * the road are left alone (the road box bridges dips).
 */
export function cutGroundForCorridor(grid: GroundGrid, frame: CorridorFrame, clearance = 0.05): number {
  let cut = 0;
  for (let z = 0; z < grid.rows; z++) {
    const wz = grid.minZ + z * grid.cellSize;
    if (wz < frame.footprint.minZ || wz > frame.footprint.maxZ) continue;
    for (let x = 0; x < grid.cols; x++) {
      const wx = grid.minX + x * grid.cellSize;
      if (wx < frame.footprint.minX || wx > frame.footprint.maxX) continue;
      const road = frame.heightAt(wx, wz);
      if (road === null) continue;
      const i = z * grid.cols + x;
      if (grid.heights[i]! > road - clearance) {
        grid.heights[i] = road - clearance;
        cut++;
      }
    }
  }
  return cut;
}

export interface CorridorOptions {
  /** Road width (m). */
  width?: number;
  /** How far the dissolve reaches above the road (m). */
  clearHeight?: number;
  fogColor?: THREE.ColorRepresentation;
  /** How many fog sprites along the road. */
  fogSprites?: number;
}

export type CorridorEnd = 'a' | 'b';

/**
 * The transition in the world: visuals under `parent`, colliders in `physics` (road, curbs, gates), the splat cut
 * as a scene-level SplatEdit. A gate stands across either end while the cell at that end has no ground in the
 * physics world (`setGate`); `dispose()` takes everything out.
 */
export class Corridor {
  readonly group = new THREE.Group();
  /** The asphalt slab (a raycast target for put-that-there). */
  readonly road: THREE.Mesh;
  readonly colliders: RAPIER.Collider[] = [];
  private readonly gates: Record<CorridorEnd, RAPIER.Collider | null> = { a: null, b: null };
  private readonly edit: SplatEdit;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly up: THREE.Vector3;
  private readonly fwd: THREE.Vector3;

  constructor(
    readonly frame: CorridorFrame,
    /** Which cell sits at each end of the road (`a` at `frame.a`, `b` at `frame.b`). */
    readonly ends: Record<CorridorEnd, string>,
    private readonly parent: THREE.Object3D,
    private readonly physics: PhysicsWorld | null,
    opts: CorridorOptions = {},
  ) {
    const { width, length, quaternion, mid } = frame;
    const clearHeight = opts.clearHeight ?? 12;
    const q = quaternion;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.up = up;
    this.fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const midV = new THREE.Vector3(...mid);
    this.group.name = 'coast-transition';

    // Asphalt: a slab whose top face is the road surface.
    const slabT = 0.3;
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.95, metalness: 0 });
    const roadGeo = new THREE.BoxGeometry(width, slabT, length);
    const road = new THREE.Mesh(roadGeo, asphalt);
    road.position.copy(midV).addScaledVector(up, -slabT / 2);
    road.quaternion.copy(q);
    this.group.add(road);
    this.road = road;
    // Centre line: a thin strip of dashes just above the surface.
    const lineTex = dashTexture();
    lineTex.repeat.set(1, Math.max(1, Math.round(length / 4)));
    const lineMat = new THREE.MeshBasicMaterial({ map: lineTex, transparent: true, depthWrite: false, opacity: 0.9 });
    const lineGeo = new THREE.PlaneGeometry(0.18, length);
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.position.copy(midV).addScaledVector(up, 0.01);
    line.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    this.group.add(line);
    // Curbs.
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 0.9 });
    const curbGeo = new THREE.BoxGeometry(0.3, 0.35, length);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(curbGeo, curbMat);
      curb.position
        .copy(midV)
        .addScaledVector(right, side * (width / 2 + 0.15))
        .addScaledVector(up, 0.175 - 0.05);
      curb.quaternion.copy(q);
      this.group.add(curb);
    }
    // Fog over the seam: big soft sprites, low alpha, in the sky/fog colour.
    const fogTex = fogTexture();
    const fogMat = new THREE.SpriteMaterial({
      map: fogTex,
      color: opts.fogColor ?? 0xb9c4d2,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const n = opts.fogSprites ?? Math.max(2, Math.round(length / 9));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const s = new THREE.Sprite(fogMat);
      const size = 7 + 3 * Math.sin(i * 1.7);
      s.scale.set(size * 1.6, size, 1);
      s.position.set(
        frame.a[0] + (frame.b[0] - frame.a[0]) * t,
        frame.a[1] + frame.rise * t + 1.4,
        frame.a[2] + (frame.b[2] - frame.a[2]) * t,
      );
      s.position.addScaledVector(right, Math.sin(i * 2.3) * 1.2);
      this.group.add(s);
    }
    this.materials.push(asphalt, lineMat, curbMat, fogMat);
    this.geometries.push(roadGeo, lineGeo, curbGeo);
    this.textures.push(lineTex, fogTex);
    parent.add(this.group);

    // The road cut in the splats: everything from just under the road to `clearHeight` above it fades out.
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1), radius: 0.5 });
    sdf.position.copy(midV).addScaledVector(up, clearHeight / 2 - 0.35);
    sdf.quaternion.copy(q);
    sdf.scale.set(width / 2 + frame.margin, clearHeight / 2, length / 2 + 0.5);
    this.edit = new SplatEdit({ name: 'coast-road-cut', rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.6, sdfs: [sdf] });
    parent.add(this.edit);

    if (physics) {
      const c = midV.clone().addScaledVector(up, -slabT / 2);
      this.colliders.push(physics.addStaticBox(c, new THREE.Vector3(width / 2, slabT / 2, length / 2), q, 0.9));
      for (const side of [-1, 1]) {
        const cc = midV
          .clone()
          .addScaledVector(right, side * (width / 2 + 0.15))
          .addScaledVector(up, 0.3);
        this.colliders.push(physics.addStaticBox(cc, new THREE.Vector3(0.15, 0.6, length / 2), q, 0.4));
      }
    }
    // Both ends start gated; the host opens an end once the cell there has ground.
    this.setGate('a', true);
    this.setGate('b', true);
  }

  gateClosed(end: CorridorEnd) {
    return this.gates[end] !== null;
  }

  /** Put up (or take down) the wall across one end of the road. */
  setGate(end: CorridorEnd, closed: boolean) {
    const physics = this.physics;
    if (!physics) return;
    const has = this.gates[end] !== null;
    if (closed === has) return;
    if (!closed) {
      physics.removeColliders([this.gates[end]!]);
      this.gates[end] = null;
      return;
    }
    const { width, length, quaternion, mid } = this.frame;
    const g = new THREE.Vector3(...mid)
      .addScaledVector(this.fwd, (end === 'b' ? 1 : -1) * (length / 2 - 0.3))
      .addScaledVector(this.up, 1.5);
    this.gates[end] = physics.addStaticBox(g, new THREE.Vector3(width / 2 + 0.3, 1.5, 0.15), quaternion, 0.2);
  }

  dispose() {
    if (this.physics) {
      this.physics.removeColliders(this.colliders);
      for (const end of ['a', 'b'] as const) if (this.gates[end]) this.physics.removeColliders([this.gates[end]!]);
    }
    this.colliders.length = 0;
    this.gates.a = this.gates.b = null;
    this.parent.remove(this.group, this.edit);
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
  }
}

function dashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 8, 64);
  g.fillStyle = '#e8dcae';
  g.fillRect(0, 8, 8, 28);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function fogTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
