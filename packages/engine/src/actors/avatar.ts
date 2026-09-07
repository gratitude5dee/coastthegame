import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

export interface AvatarReport {
  boneCount: number;
  triangles: number;
  heightM: number;
  clips: string[];
  rig: 'mixamo' | 'unrigged' | 'unsupported';
  warnings: string[];
}

export interface AvatarOptions {
  id: string;
  name: string;
  forward?: '-Z' | '+Z';
  heightM?: number;
}

export function avatarMaterials(root: THREE.Object3D): Set<THREE.Material> {
  const materials = new Set<THREE.Material>();
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      const material = (node as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
    }
  });
  return materials;
}

export function disposeAvatarResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const skeletons = new Set<THREE.Skeleton>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) geometries.add((node as THREE.Mesh).geometry);
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton);
  });
  for (const material of avatarMaterials(root)) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    const image: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

export class AvatarAsset {
  readonly id: string;
  readonly name: string;
  private instances = 0;
  private disposed = false;
  private released = false;

  constructor(
    private readonly template: THREE.Group,
    private readonly animations: THREE.AnimationClip[],
    readonly report: AvatarReport,
    opts: AvatarOptions,
  ) {
    this.id = opts.id;
    this.name = opts.name;
  }

  instantiate(): Avatar {
    if (this.disposed) throw new Error('Avatar asset is disposed.');
    const model = clone(this.template) as THREE.Group;
    const materials = new Map<THREE.Material, THREE.Material>();
    model.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        const owned = (material: THREE.Material) => {
          if (!materials.has(material)) materials.set(material, material.clone());
          return materials.get(material)!;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(owned) : owned(mesh.material);
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          const skin = mesh as THREE.SkinnedMesh;
          skin.skeleton.boneInverses = skin.skeleton.boneInverses.map((matrix) => matrix.clone());
          skin.frustumCulled = false;
        }
      }
    });
    this.instances++;
    return new Avatar(model, this.animations, this.report.rig, () => {
      this.instances--;
      this.release();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }

  private release(): void {
    if (this.disposed && !this.instances && !this.released) {
      this.released = true;
      disposeAvatarResources(this.template);
    }
  }
}

type Rest = {
  node: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  morphs?: number[];
};
type Joint = { node: THREE.Object3D; idle: THREE.Quaternion; axis: THREE.Vector3 };

export class Avatar {
  readonly group = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly rest: Rest[] = [];
  private readonly joints = new Map<string, Joint>();
  private readonly materials: Set<THREE.Material>;
  private readonly materialDefaults = new Map<
    THREE.Material,
    { color?: THREE.Color; opacity: number; transparent: boolean; depthWrite: boolean }
  >();
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private disposed = false;
  private readonly turn = new THREE.Quaternion();

  constructor(
    private readonly model: THREE.Group,
    clips: THREE.AnimationClip[],
    private readonly rig: AvatarReport['rig'],
    private readonly release: () => void,
  ) {
    this.group.name = 'avatar';
    this.group.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    model.updateMatrixWorld(true);
    model.traverse((node) => {
      const morphs = (node as THREE.Mesh).morphTargetInfluences;
      this.rest.push({
        node,
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
        ...(morphs ? { morphs: [...morphs] } : {}),
      });
    });
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.materials = avatarMaterials(model);
    for (const material of this.materials) {
      const color = (material as THREE.MeshStandardMaterial).color;
      this.materialDefaults.set(material, {
        ...(color ? { color: color.clone() } : {}),
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
      });
    }
    if (rig === 'mixamo') this.calibrate();
    this.sample(0, 0);
  }

  private calibrate(): void {
    for (const side of ['Left', 'Right']) {
      const arm = this.model.getObjectByName(`mixamorig${side}Arm`);
      const forearm = this.model.getObjectByName(`mixamorig${side}ForeArm`);
      if (arm && forearm) {
        const from = forearm.getWorldPosition(new THREE.Vector3()).sub(arm.getWorldPosition(new THREE.Vector3())).normalize();
        const to = new THREE.Vector3(Math.sign(from.x) * 0.18, -0.984, 0).normalize();
        const parent = arm.parent!.getWorldQuaternion(new THREE.Quaternion());
        const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
        arm.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));
        this.model.updateMatrixWorld(true);
      }
    }
    const forwardAxis = new THREE.Vector3(1, 0, 0);
    for (const side of ['Left', 'Right']) {
      for (const part of ['Arm', 'ForeArm', 'UpLeg', 'Leg', 'Foot']) {
        const name = `${side}${part}`;
        const node = this.model.getObjectByName(`mixamorig${name}`);
        if (!node) continue;
        const inverse = node.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
        this.joints.set(name, { node, idle: node.quaternion.clone(), axis: forwardAxis.clone().applyQuaternion(inverse).normalize() });
      }
    }
    this.restore();
  }

  private restore(): void {
    for (const rest of this.rest) {
      rest.node.position.copy(rest.position);
      rest.node.quaternion.copy(rest.quaternion);
      rest.node.scale.copy(rest.scale);
      if (rest.morphs) (rest.node as THREE.Mesh).morphTargetInfluences!.splice(0, rest.morphs.length, ...rest.morphs);
    }
  }

  sample(timeS: number, speed: number, grounded = true): void {
    if (this.disposed) throw new Error('Avatar is disposed.');
    if (!Number.isFinite(timeS) || !Number.isFinite(speed) || speed < 0 || typeof grounded !== 'boolean')
      throw new Error('Avatar sample needs finite time, nonnegative speed and a grounded boolean.');
    this.mixer.stopAllAction();
    this.restore();
    const state = !grounded ? 'fall' : speed < 0.1 ? 'idle' : speed > 4.5 ? 'run' : 'walk';
    const find = (name: string) => this.actions.get(name) ?? [...this.actions].find(([key]) => key.startsWith(`${name}_`))?.[1];
    const action = find(state) ?? (state === 'run' ? find('walk') : undefined);
    if (action) {
      action.reset().play();
      const duration = action.getClip().duration;
      action.time = ((timeS % duration) + duration) % duration;
      this.mixer.update(0);
    } else if (this.rig === 'mixamo') {
      const amount = grounded ? THREE.MathUtils.clamp(speed / 3.2, 0, 1) : 0;
      const phase = timeS * Math.PI * 2 * (speed > 4.5 ? 2.2 : 1.4);
      for (const [name, joint] of this.joints) {
        const wave = Math.sin(phase + (name.startsWith('Left') ? 0 : Math.PI));
        let angle = 0;
        if (name.endsWith('UpLeg')) angle = wave * 0.48 * amount;
        else if (name.endsWith('Leg')) angle = -Math.max(0, -wave) * 0.65 * amount;
        else if (name.endsWith('ForeArm')) angle = -0.12 - amount * 0.15;
        else if (name.endsWith('Arm')) angle = -wave * 0.35 * amount;
        else if (name.endsWith('Foot')) angle = -wave * 0.1 * amount;
        joint.node.quaternion.copy(joint.idle).premultiply(this.turn.setFromAxisAngle(joint.axis, angle));
      }
    }
    this.group.updateMatrixWorld(true);
    this.model.traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) (node as THREE.SkinnedMesh).skeleton.update();
    });
  }

  boneWorldPositions(): Record<string, [number, number, number]> | null {
    if (this.disposed) throw new Error('Avatar is disposed.');
    if (this.rig !== 'mixamo') return null;
    this.group.updateWorldMatrix(true, true);
    const positions: Record<string, [number, number, number]> = {};
    const canonical =
      /^mixamorig(?:Hips|Spine[12]?|Neck|Head|(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand(?:(?:Thumb|Index|Middle|Ring|Pinky)[1-4])?|UpLeg|Leg|Foot|ToeBase|Eye))$/;
    this.model.traverse((node) => {
      if (!(node as THREE.Bone).isBone || !canonical.test(node.name)) return;
      const e = node.matrixWorld.elements;
      positions[node.name] = [e[12]!, e[13]!, e[14]!];
    });
    return positions;
  }

  setTint(color: number): void {
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff) throw new Error('Avatar tint must be a 24-bit color.');
    const tint = new THREE.Color(color);
    for (const [material, defaults] of this.materialDefaults) {
      if (defaults.color) (material as THREE.MeshStandardMaterial).color.copy(defaults.color).multiply(tint);
    }
  }

  setOpacity(opacity: number): void {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Avatar opacity must be between 0 and 1.');
    for (const [material, defaults] of this.materialDefaults) {
      material.opacity = defaults.opacity * opacity;
      material.transparent = defaults.transparent || opacity < 1;
      material.depthWrite = defaults.depthWrite && opacity === 1;
      material.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const material of this.materials) material.dispose();
    const skeletons = new Set<THREE.Skeleton>();
    this.model.traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton);
    });
    for (const skeleton of skeletons) skeleton.dispose();
    this.group.removeFromParent();
    this.release();
  }
}
