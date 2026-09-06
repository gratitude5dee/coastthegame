/**
 * Props (goal.md PHY-2, DIR-3 fallback): dynamic rigid bodies with simple meshes, click-to-select → click-to-place
 * "put that there" with a ghost preview and undo, and grab/throw. Real GLB props arrive with the asset factory (M4);
 * the interface stays the same.
 */
import * as THREE from 'three';
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world';

export type PropShape = 'box' | 'cylinder' | 'ball';

export interface PropSpec {
  id: string;
  shape: PropShape;
  /** Half extents for box (x,y,z); [radius, halfHeight] for cylinder; [radius] for ball. */
  size: number[];
  color: number;
  mass?: number;
  tags?: string[];
}

export interface Prop {
  spec: PropSpec;
  mesh: THREE.Mesh;
  body: RAPIER_NS.RigidBody;
  collider: RAPIER_NS.Collider;
  /** Render-interpolation state (previous / current fixed step). */
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
}

type Op = { kind: 'move'; id: string; from: THREE.Vector3; fromQuat: THREE.Quaternion } | { kind: 'spawn'; id: string };

const HIGHLIGHT = 0xffb54a;

export class PropSystem {
  readonly props = new Map<string, Prop>();
  readonly group = new THREE.Group();
  readonly ghost: THREE.Mesh;
  selected: Prop | null = null;
  grabbed: Prop | null = null;
  private undoStack: Op[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private counter = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Object3D,
  ) {
    scene.add(this.group);
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    scene.add(this.ghost);
  }

  spawn(spec: PropSpec, position: THREE.Vector3, yaw = 0): Prop {
    const R = this.physics.R;
    let geometry: THREE.BufferGeometry;
    let colliderDesc: RAPIER_NS.ColliderDesc;
    if (spec.shape === 'box') {
      const [hx = 0.3, hy = 0.3, hz = 0.3] = spec.size;
      geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
      colliderDesc = R.ColliderDesc.cuboid(hx, hy, hz);
    } else if (spec.shape === 'cylinder') {
      const [r = 0.3, hh = 0.4] = spec.size;
      geometry = new THREE.CylinderGeometry(r, r, hh * 2, 24);
      colliderDesc = R.ColliderDesc.cylinder(hh, r);
    } else {
      const [r = 0.3] = spec.size;
      geometry = new THREE.SphereGeometry(r, 24, 16);
      colliderDesc = R.ColliderDesc.ball(r);
    }
    colliderDesc
      .setRestitution(0.2)
      .setFriction(0.9)
      .setMass(spec.mass ?? 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.55, metalness: 0.1 }));
    mesh.castShadow = false;
    mesh.name = spec.id;
    mesh.position.copy(position);
    mesh.rotation.y = yaw;
    this.group.add(mesh);

    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0.15)
        .setAngularDamping(0.4)
        .setCcdEnabled(true),
    );
    const collider = this.physics.world.createCollider(colliderDesc, body);
    const prop: Prop = { spec, mesh, body, collider, prevPos: position.clone(), prevQuat: mesh.quaternion.clone() };
    this.props.set(spec.id, prop);
    this.undoStack.push({ kind: 'spawn', id: spec.id });
    return prop;
  }

  /** Call before each fixed step to capture previous poses for interpolation. */
  beforeStep() {
    for (const p of this.props.values()) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.prevPos.set(t.x, t.y, t.z);
      p.prevQuat.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Sync meshes from bodies with interpolation. */
  sync(alpha: number) {
    for (const p of this.props.values()) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z).lerp(p.prevPos, 1 - alpha);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      p.mesh.quaternion.slerp(p.prevQuat, 1 - alpha);
    }
  }

  /** Ray pick against prop meshes (click-to-select). */
  pick(ray: THREE.Ray): Prop | null {
    this.raycaster.ray.copy(ray);
    const hits = this.raycaster.intersectObjects(
      [...this.props.values()].map((p) => p.mesh),
      false,
    );
    const hit = hits[0];
    return hit ? (this.props.get(hit.object.name) ?? null) : null;
  }

  select(prop: Prop | null) {
    if (this.selected) (this.selected.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
    this.selected = prop;
    if (prop) (prop.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x553a10);
    if (!prop) this.ghost.visible = false;
  }

  /** Show the ghost of the selected prop at a candidate place (DIR-3 ghost preview). */
  previewAt(point: THREE.Vector3 | null) {
    if (!this.selected || !point) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.geometry = this.selected.mesh.geometry;
    this.ghost.position.copy(point).add(this.restOffset(this.selected));
    this.ghost.quaternion.copy(this.selected.mesh.quaternion);
    this.ghost.visible = true;
  }

  /** "Put that there": teleport the selected prop to a ground point (rest offset applied), recorded for undo. */
  placeSelectedAt(point: THREE.Vector3): boolean {
    const p = this.selected;
    if (!p) return false;
    const t = p.body.translation();
    const r = p.body.rotation();
    this.undoStack.push({
      kind: 'move',
      id: p.spec.id,
      from: new THREE.Vector3(t.x, t.y, t.z),
      fromQuat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    });
    const dest = point.clone().add(this.restOffset(p));
    p.body.setTranslation({ x: dest.x, y: dest.y, z: dest.z }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.prevPos.copy(dest);
    this.ghost.visible = false;
    this.select(null);
    performance.mark('coast:act-preview');
    return true;
  }

  /** Kinematic replay (STU-1): put a prop at a recorded pose — body, interpolation state and mesh at once. */
  setPose(id: string, pos: [number, number, number], quat: [number, number, number, number]): boolean {
    const p = this.props.get(id);
    if (!p) return false;
    p.body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, true);
    p.body.setRotation({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.prevPos.set(pos[0], pos[1], pos[2]);
    p.prevQuat.set(quat[0], quat[1], quat[2], quat[3]);
    p.mesh.position.copy(p.prevPos);
    p.mesh.quaternion.copy(p.prevQuat);
    return true;
  }

  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    const p = this.props.get(op.id);
    if (!p) return false;
    if (op.kind === 'move') {
      p.body.setTranslation({ x: op.from.x, y: op.from.y, z: op.from.z }, true);
      p.body.setRotation({ x: op.fromQuat.x, y: op.fromQuat.y, z: op.fromQuat.z, w: op.fromQuat.w }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.prevPos.copy(op.from);
    } else {
      this.remove(op.id);
    }
    return true;
  }

  remove(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    this.physics.world.removeRigidBody(p.body);
    this.group.remove(p.mesh);
    p.mesh.geometry.dispose();
    (p.mesh.material as THREE.Material).dispose();
    this.props.delete(id);
    if (this.selected === p) this.select(null);
    if (this.grabbed === p) this.grabbed = null;
  }

  /** Grab: the body becomes kinematic and follows `holdPoint` each frame until released. */
  grab(prop: Prop) {
    if (this.grabbed) this.release(null);
    this.grabbed = prop;
    prop.body.setBodyType(this.physics.R.RigidBodyType.KinematicPositionBased, true);
  }

  updateGrabbed(holdPoint: THREE.Vector3) {
    const p = this.grabbed;
    if (!p) return;
    p.body.setNextKinematicTranslation({ x: holdPoint.x, y: holdPoint.y, z: holdPoint.z });
  }

  /** Release (drop) or throw with a velocity (m/s). */
  release(throwVelocity: THREE.Vector3 | null) {
    const p = this.grabbed;
    if (!p) return;
    this.grabbed = null;
    p.body.setBodyType(this.physics.R.RigidBodyType.Dynamic, true);
    if (throwVelocity) p.body.setLinvel({ x: throwVelocity.x, y: throwVelocity.y, z: throwVelocity.z }, true);
  }

  nextId(prefix: string) {
    return `${prefix}_${++this.counter}`;
  }

  private restOffset(p: Prop): THREE.Vector3 {
    const s = p.spec.size;
    const h = p.spec.shape === 'box' ? (s[1] ?? 0.3) : p.spec.shape === 'cylinder' ? (s[1] ?? 0.4) : (s[0] ?? 0.3);
    return new THREE.Vector3(0, h + 0.02, 0);
  }
}
