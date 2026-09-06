// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
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

  it('without a car template a driving pose keeps the body', () => {
    const ghost = new GhostActor(new THREE.Scene(), body(), null, { color: 0xffffff, name: 'x' });
    ghost.setPose({ pos: [0, 0, 0], yaw: 0, speed: 0, driving: true, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1] });
    expect((ghost.group.children[0] as THREE.Group).visible).toBe(true);
    expect(ghost.group.children).toHaveLength(1);
  });
});
