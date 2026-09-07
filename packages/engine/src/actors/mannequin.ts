import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type AvatarAsset } from './avatar';
import { prepareAvatar } from './prepareAvatar';

export function createMannequin(): AvatarAsset {
  const scene = new THREE.Group();
  scene.name = 'mannequin';
  const bones: THREE.Bone[] = [];
  const byName = new Map<string, THREE.Bone>();
  const bone = (name: string, parent: string | null, x: number, y: number, z = 0) => {
    const joint = new THREE.Bone();
    joint.name = `mixamorig${name}`;
    joint.position.set(x, y, z);
    const owner = parent ? byName.get(parent)! : scene;
    if (parent) joint.position.sub(owner.getWorldPosition(new THREE.Vector3()));
    owner.add(joint);
    scene.updateMatrixWorld(true);
    bones.push(joint);
    byName.set(name, joint);
  };
  bone('Hips', null, 0, 0.94);
  bone('Spine', 'Hips', 0, 1.06);
  bone('Spine1', 'Spine', 0, 1.2);
  bone('Spine2', 'Spine1', 0, 1.4);
  bone('Neck', 'Spine2', 0, 1.53);
  bone('Head', 'Neck', 0, 1.64);
  for (const [side, sign] of [
    ['Left', 1],
    ['Right', -1],
  ] as const) {
    bone(`${side}Shoulder`, 'Spine2', sign * 0.12, 1.43);
    bone(`${side}Arm`, `${side}Shoulder`, sign * 0.23, 1.43);
    bone(`${side}ForeArm`, `${side}Arm`, sign * 0.5, 1.43);
    bone(`${side}Hand`, `${side}ForeArm`, sign * 0.74, 1.43);
    bone(`${side}UpLeg`, 'Hips', sign * 0.105, 0.9);
    bone(`${side}Leg`, `${side}UpLeg`, sign * 0.105, 0.5);
    bone(`${side}Foot`, `${side}Leg`, sign * 0.105, 0.12);
    bone(`${side}ToeBase`, `${side}Foot`, sign * 0.105, 0.06, -0.18);
  }
  const parts: THREE.BufferGeometry[] = [];
  const part = (joint: string, size: [number, number, number], center: [number, number, number], color: number) => {
    const geometry = new THREE.BoxGeometry(...size);
    geometry.translate(...center);
    const count = geometry.getAttribute('position').count;
    const indices = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    const colors = new Float32Array(count * 3);
    const tint = new THREE.Color(color);
    const index = bones.indexOf(byName.get(joint)!);
    for (let i = 0; i < count; i++) {
      indices[i * 4] = index;
      weights[i * 4] = 1;
      tint.toArray(colors, i * 3);
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  part('Hips', [0.35, 0.2, 0.24], [0, 0.94, 0], 0x33444a);
  part('Spine1', [0.4, 0.38, 0.25], [0, 1.22, 0], 0x6d9b92);
  part('Neck', [0.13, 0.12, 0.13], [0, 1.5, 0], 0xd9b88f);
  part('Head', [0.28, 0.32, 0.26], [0, 1.64, 0], 0xd9b88f);
  part('Head', [0.07, 0.06, 0.06], [0, 1.64, -0.15], 0xcfa47b);
  for (const sign of [-1, 1]) {
    part('Head', [0.035, 0.035, 0.012], [sign * 0.065, 1.685, -0.134], 0x23343b);
    const side = sign === 1 ? 'Left' : 'Right';
    part(`${side}Arm`, [0.28, 0.16, 0.18], [sign * 0.36, 1.43, 0], 0x6d9b92);
    part(`${side}ForeArm`, [0.24, 0.12, 0.13], [sign * 0.62, 1.43, 0], 0xd9b88f);
    part(`${side}Hand`, [0.13, 0.1, 0.15], [sign * 0.79, 1.43, 0], 0xd9b88f);
    part(`${side}UpLeg`, [0.155, 0.4, 0.18], [sign * 0.105, 0.7, 0], 0x33444a);
    part(`${side}Leg`, [0.135, 0.38, 0.155], [sign * 0.105, 0.31, 0], 0x33444a);
    part(`${side}Foot`, [0.165, 0.12, 0.3], [sign * 0.105, 0.06, -0.065], 0x202d34);
  }
  const geometry = mergeGeometries(parts)!;
  for (const piece of parts) piece.dispose();
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
  mesh.name = 'mannequin_body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return prepareAvatar(scene, [], { id: 'mannequin', name: 'Coast mannequin', forward: '-Z', heightM: 1.8 });
}
