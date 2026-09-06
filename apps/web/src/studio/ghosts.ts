/**
 * Ghost actors (goal.md ACT-2 replay, STU-1): a translucent body driven by a take's authoritative poses — a capsule in
 * the performer's colour on foot, a see-through lowrider when the take was driven. Placeholders until the skinned rigs
 * (M4) replace both templates; the pose contract (`TakePose`) stays.
 */
import * as THREE from 'three';
import type { TakePose } from '@coast/studio';

export interface ActorLook {
  color: number;
  name: string;
}

const GHOST_OPACITY = 0.45;

/** Deep-clone the visual hierarchy only — audio nodes (the lowrider's engine hum rides on its group) stay behind. */
function cloneVisual(src: THREE.Object3D): THREE.Object3D | null {
  if (/Audio/.test(src.type)) return null;
  const c = src.clone(false);
  for (const child of src.children) {
    const cc = cloneVisual(child);
    if (cc) c.add(cc);
  }
  return c;
}

/** Clone a template with translucent materials; `tint` recolours the main body when given. */
function ghostify(template: THREE.Object3D, tint?: number): THREE.Group {
  const g = (cloneVisual(template) ?? new THREE.Group()) as THREE.Group;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    const mat = src.clone();
    mat.transparent = true;
    mat.opacity = GHOST_OPACITY;
    mat.depthWrite = false;
    if (tint !== undefined && m.geometry.type === 'CapsuleGeometry') mat.color.setHex(tint);
    m.material = mat;
    m.castShadow = false;
  });
  g.visible = true;
  return g;
}

export class GhostActor {
  readonly group = new THREE.Group();
  private readonly body: THREE.Group;
  private readonly car: THREE.Group | null;

  /**
   * @param bodyTemplate  the player placeholder (capsule + nose) — cloned and tinted with the look's colour
   * @param carTemplate   the lowrider's visual group, cloned translucent (null when the level has no car)
   * @param carFeetDrop   recorded driving poses are the car's "feet" (chassis − drop); the ghost car sits `drop` above
   */
  constructor(
    parent: THREE.Object3D,
    bodyTemplate: THREE.Object3D,
    carTemplate: THREE.Object3D | null,
    readonly look: ActorLook,
    carFeetDrop = 0,
  ) {
    this.body = ghostify(bodyTemplate, look.color);
    this.car = carTemplate ? ghostify(carTemplate) : null;
    this.car?.position.set(0, carFeetDrop, 0);
    if (this.car) this.car.visible = false;
    this.group.add(this.body);
    if (this.car) this.group.add(this.car);
    this.group.name = `ghost:${look.name}`;
    this.group.visible = false;
    parent.add(this.group);
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Place the ghost at a replayed pose; a driving pose shows the car instead of the body. */
  setPose(pose: TakePose) {
    this.group.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.group.rotation.y = pose.yaw;
    const driving = pose.driving && !!this.car;
    this.body.visible = !driving;
    if (this.car) this.car.visible = driving;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (m.material as THREE.Material).dispose();
    });
  }
}
