// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { AvatarAsset } from '../../packages/engine/src/actors/avatar';
import * as THREE from 'three';
import { GhostActor } from '../../apps/web/src/studio/ghosts';

/** goal.md ACT-2 replay bodies: translucent, tinted, a car for driving poses, and never a copy of the engine hum. */
describe('GhostActor', () => {
  const body = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1), new THREE.MeshStandardMaterial({ color: 0xffb54a })));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x000000 })));
    return g;
  };
  const car = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0xc0102a })));
    const hum = new THREE.Object3D(); // stands in for the PositionalAudio engine hum (happy-dom has no WebAudio)
    hum.type = 'PositionalAudio';
    g.add(hum);
    return g;
  };

  it('tints the capsule with the look, makes everything translucent and leaves audio out of the clone', () => {
    const scene = new THREE.Scene();
    const ghost = new GhostActor(scene, body(), car(), { color: 0x4fa3d9, name: 'Photographer' }, 0.6);
    expect(ghost.group.parent).toBe(scene);
    expect(ghost.visible).toBe(false);
    expect(ghost.boneWorldPositions()).toBeUndefined();
    const mats: THREE.MeshStandardMaterial[] = [];
    let audio = 0;
    ghost.group.traverse((o) => {
      if (/Audio/.test(o.type)) audio++;
      const m = o as THREE.Mesh;
      if (m.isMesh) mats.push(m.material as THREE.MeshStandardMaterial);
    });
    expect(audio).toBe(0);
    expect(mats).toHaveLength(3);
    expect(mats.every((m) => m.transparent && m.opacity < 1 && !m.depthWrite)).toBe(true);
    const capsule = mats.find((m) => m.color.getHex() === 0x4fa3d9);
    expect(capsule).toBeDefined();
  });

  it('shows the body for a walking pose and the car (lifted by the feet drop) for a driving pose', () => {
    const scene = new THREE.Scene();
    const ghost = new GhostActor(scene, body(), car(), { color: 0xffffff, name: 'x' }, 0.6);
    const pose = {
      pos: [1, 2, 3] as [number, number, number],
      yaw: 0.5,
      speed: 1,
      driving: false,
      camPos: [0, 0, 0] as [number, number, number],
      camQuat: [0, 0, 0, 1] as [number, number, number, number],
    };
    ghost.setPose(pose);
    expect(ghost.group.position.toArray()).toEqual([1, 2, 3]);
    expect(ghost.group.rotation.y).toBeCloseTo(0.5);
    const [bodyG, carG] = ghost.group.children as THREE.Group[];
    expect(bodyG!.visible).toBe(true);
    expect(carG!.visible).toBe(false);
    ghost.setPose({ ...pose, driving: true });
    expect(bodyG!.visible).toBe(false);
    expect(carG!.visible).toBe(true);
    expect(carG!.position.y).toBeCloseTo(0.6);
    ghost.dispose();
    expect(ghost.group.parent).toBeNull();
  });

  it('seeks independent skinned instances absolutely and isolates outfit, alpha and resource disposal', () => {
    const template = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'mixamorigLeftUpLeg';
    const geometry = new THREE.BoxGeometry(0.2, 1, 0.2);
    const vertices = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
    const weights = new Float32Array(vertices * 4);
    for (let i = 0; i < vertices; i++) weights[i * 4] = 1;
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
    ];
    const mesh = new THREE.SkinnedMesh(geometry, materials);
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    template.add(mesh);
    const clip = new THREE.AnimationClip('walk', 2, [
      new THREE.NumberKeyframeTrack('mixamorigLeftUpLeg.rotation[x]', [0, 1, 2], [0, 0.8, 0]),
    ]);
    const asset = new AvatarAsset(
      template,
      [clip],
      {
        boneCount: 1,
        triangles: 12,
        heightM: 1,
        clips: ['walk'],
        rig: 'mixamo',
        warnings: [],
      },
      { id: 'rig', name: 'Rig' },
    );
    const live = asset.instantiate();
    const scene = new THREE.Scene();
    const unusedTemplate = body();
    const cloneSpy = vi.spyOn(unusedTemplate, 'clone');
    const a = new GhostActor(scene, unusedTemplate, car(), { color: 0xff0000, name: 'Red' }, 0.6, asset);
    const b = new GhostActor(scene, unusedTemplate, null, { color: 0x0000ff, name: 'Blue' }, 0, asset);
    expect(cloneSpy).not.toHaveBeenCalled();
    const skin = (root: THREE.Object3D) => root.getObjectByProperty('type', 'SkinnedMesh') as THREE.SkinnedMesh;
    const sa = skin(a.group);
    const sb = skin(b.group);
    expect(sa.skeleton).not.toBe(sb.skeleton);
    expect(sa.skeleton.bones[0]).not.toBe(sb.skeleton.bones[0]);
    expect(sa.skeleton.bones[0]).not.toBe(bone);
    expect(sa.geometry).toBe(geometry);
    const ma = sa.material as THREE.MeshStandardMaterial[];
    const mb = sb.material as THREE.MeshStandardMaterial[];
    expect(ma).toHaveLength(2);
    expect(ma[0]).not.toBe(mb[0]);
    expect(ma[0]!.color.getHex()).toBe(0xff0000);
    expect(mb[0]!.color.getHex()).toBe(0x0000ff);
    expect(ma[1]!.opacity).toBeCloseTo(0.6 * 0.45);
    live.setTint(0x00ff00);
    expect(ma[0]!.color.getHex()).toBe(0xff0000);
    a.setSolid(true);
    expect(ma[0]!.opacity).toBe(1);
    expect(ma[0]!.transparent).toBe(false);
    expect(ma[1]!.opacity).toBe(0.6);
    expect(ma[1]!.transparent).toBe(true);
    expect(ma[1]!.depthWrite).toBe(false);
    expect(mb[0]!.opacity).toBe(0.45);
    a.setSolid(false);
    expect(ma[1]!.opacity).toBeCloseTo(0.6 * 0.45);
    const pose = {
      pos: [1, 2, 3] as [number, number, number],
      yaw: 0.5,
      speed: 2,
      grounded: true,
      driving: false,
      camPos: [0, 0, 0] as [number, number, number],
      camQuat: [0, 0, 0, 1] as [number, number, number, number],
    };
    a.setPose(pose, 0.5);
    b.setPose(pose, 1);
    expect(a.boneWorldPositions()?.mixamorigLeftUpLeg).toEqual([1, 2, 3]);
    const expected = sa.skeleton.bones[0]!.quaternion.toArray();
    expect(sa.skeleton.bones[0]!.rotation.x).toBeCloseTo(0.4);
    expect(sb.skeleton.bones[0]!.rotation.x).toBeCloseTo(0.8);
    a.setPose(pose, 1.8);
    a.setPose({ ...pose, grounded: false }, 0.9);
    a.setPose(pose, 0.5);
    expect(sa.skeleton.bones[0]!.quaternion.toArray()).toEqual(expected);
    expect(sb.skeleton.bones[0]!.rotation.x).toBeCloseTo(0.8);
    expect(bone.rotation.x).toBe(0);
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(materials[0]!, 'dispose');
    const instanceDispose = vi.spyOn(ma[0]!, 'dispose');
    a.dispose();
    a.dispose();
    expect(instanceDispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
    b.setPose(pose, 0.5);
    expect(sb.skeleton.bones[0]!.quaternion.toArray()).toEqual(expected);
    b.dispose();
    live.dispose();
    asset.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('clones and disposes every material in legacy template arrays', () => {
    const template = body();
    const mesh = template.children[0] as THREE.Mesh;
    mesh.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const ghost = new GhostActor(new THREE.Scene(), template, null, { color: 0xffffff, name: 'Legacy' });
    const cloned = (ghost.group.children[0]!.children[0] as THREE.Mesh).material as THREE.Material[];
    expect(cloned).toHaveLength(2);
    const disposed = cloned.map((material) => vi.spyOn(material, 'dispose'));
    ghost.setSolid(true);
    expect(cloned.every((material) => material.opacity === 1 && !material.transparent && material.depthWrite)).toBe(true);
    ghost.setSolid(false);
    expect(cloned.every((material) => material.opacity === 0.45 && material.transparent && !material.depthWrite)).toBe(true);
    ghost.dispose();
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('without a car template a driving pose keeps the body', () => {
    const ghost = new GhostActor(new THREE.Scene(), body(), null, { color: 0xffffff, name: 'x' });
    ghost.setPose({ pos: [0, 0, 0], yaw: 0, speed: 0, driving: true, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1] });
    expect((ghost.group.children[0] as THREE.Group).visible).toBe(true);
    expect(ghost.group.children).toHaveLength(1);
  });
});
