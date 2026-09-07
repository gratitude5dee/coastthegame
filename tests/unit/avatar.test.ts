import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createMannequin, loadAvatar, readAvatarBytes, prepareAvatar, normalizeAvatarBoneName } from '@coast/engine';

const opts = { id: 'test', name: 'Test avatar' };
const meshOf = (root: THREE.Object3D) => root.getObjectByProperty('type', 'SkinnedMesh') as THREE.SkinnedMesh;
const skinnedVertices = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true);
  const mesh = meshOf(root);
  return Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, index) =>
    mesh.localToWorld(mesh.getVertexPosition(index, new THREE.Vector3())),
  );
};
const pose = (root: THREE.Object3D) => {
  const values: number[] = [];
  root.traverse((node) => values.push(...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()));
  return values;
};
function glb(json: object, binary?: ArrayBuffer): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = binary ? Math.ceil(binary.byteLength / 4) * 4 : 0;
  const data = new ArrayBuffer(20 + jsonLength + (binary ? 8 + binLength : 0));
  const view = new DataView(data);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, data.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(data, 20, jsonLength).fill(32);
  new Uint8Array(data, 20, text.length).set(text);
  if (binary) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    new Uint8Array(data, 28 + jsonLength, binary.byteLength).set(new Uint8Array(binary));
  }
  return data;
}
const triangleGlb = () =>
  glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 2, 0] }],
    },
    new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 2, 0]).buffer,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CHR-1/2 shared avatars', () => {
  it('returns owned validated bytes so persistence never needs to retain a source URL', async () => {
    const source = triangleGlb();
    const copy = await readAvatarBytes(source);
    expect(copy).not.toBe(source);
    expect(new Uint8Array(copy)).toEqual(new Uint8Array(source));
    new Uint8Array(source).fill(0);
    const asset = await loadAvatar(copy, opts);
    expect(asset.report.rig).toBe('unrigged');
    asset.dispose();
    await expect(readAvatarBytes(source)).rejects.toThrow(/GLB/);
  });

  it('downloads a source only once when its retained bytes are subsequently parsed', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(triangleGlb()));
    vi.stubGlobal('fetch', transport);
    const data = await readAvatarBytes('https://assets.example/avatar.glb');
    const asset = await loadAvatar(data, opts);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith(
      'https://assets.example/avatar.glb',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    );
    asset.dispose();
  });

  it('builds a known-good low-poly metre-scale Mixamo mannequin, feet grounded, arms lowered at idle', () => {
    const asset = createMannequin();
    expect(asset.report.rig).toBe('mixamo');
    expect(asset.report.boneCount).toBeGreaterThanOrEqual(20);
    expect(asset.report.boneCount).toBeLessThanOrEqual(80);
    expect(asset.report.triangles).toBeGreaterThan(100);
    expect(asset.report.triangles).toBeLessThan(2000);
    expect(asset.report.heightM).toBeCloseTo(1.8);
    expect(asset.report.clips).toEqual([]);
    const avatar = asset.instantiate();
    avatar.sample(0, 0);
    const box = new THREE.Box3().setFromObject(avatar.group, true);
    expect(box.min.y).toBeCloseTo(0, 4);
    const hand = avatar.group.getObjectByName('mixamorigLeftHand')!;
    const arm = avatar.group.getObjectByName('mixamorigLeftArm')!;
    expect(hand.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(arm.getWorldPosition(new THREE.Vector3()).y - 0.35);
    avatar.dispose();
    asset.dispose();
  });

  it.each(['+Z', '-Z'] as const)(
    'skins CPU vertices through centimetre normalization and %s orientation exactly once without rebinding',
    (forward) => {
      const fixture = createMannequin();
      const source = fixture.instantiate();
      const sourceMesh = meshOf(source.group);
      sourceMesh.skeleton.pose();
      source.group.scale.setScalar(100);
      source.group.position.set(120, 35, -70);
      const rotation = new THREE.Matrix4().makeRotationY(forward === '+Z' ? Math.PI : 0);
      const oriented = skinnedVertices(source.group).map((vertex) => vertex.applyMatrix4(rotation));
      const sourceBounds = new THREE.Box3().setFromPoints(oriented);
      const heightM = 1.65;
      const scale = heightM / (sourceBounds.max.y - sourceBounds.min.y);
      const offset = sourceBounds.getCenter(new THREE.Vector3());
      offset.y = sourceBounds.min.y;
      const expectedRest = oriented.map((vertex) => vertex.sub(offset).multiplyScalar(scale));
      const inverseBinds = sourceMesh.skeleton.boneInverses.map((matrix) => matrix.toArray());
      const calculateInverses = vi.spyOn(THREE.Skeleton.prototype, 'calculateInverses');
      const asset = prepareAvatar(source.group, [], { ...opts, heightM, forward });
      const avatar = asset.instantiate();
      const mesh = meshOf(avatar.group);
      expect(mesh.bindMode).toBe(THREE.AttachedBindMode);
      mesh.skeleton.pose();
      const rest = skinnedVertices(avatar.group);
      rest.forEach((vertex, index) => expect(vertex.distanceTo(expectedRest[index]!)).toBeLessThan(1e-5));
      const restBounds = new THREE.Box3().setFromPoints(rest);
      expect(restBounds.min.y).toBeCloseTo(0, 5);
      expect(restBounds.max.y).toBeCloseTo(heightM, 5);
      const bind = vi.spyOn(mesh, 'bind');
      avatar.sample(0, 0);
      const idle = skinnedVertices(avatar.group);
      const idleBounds = new THREE.Box3().setFromPoints(idle);
      expect(idleBounds.min.y).toBeCloseTo(0, 5);
      expect(idleBounds.max.y).toBeCloseTo(heightM, 5);
      expect(idleBounds.max.x - idleBounds.min.x).toBeLessThan((restBounds.max.x - restBounds.min.x) * 0.7);
      const skinIndices = mesh.geometry.getAttribute('skinIndex');
      for (const side of ['Left', 'Right']) {
        const hand = mesh.skeleton.bones.findIndex((bone) => bone.name === `mixamorig${side}Hand`);
        const indices = rest.flatMap((_, index) => (skinIndices.getX(index) === hand ? [index] : []));
        expect(indices.length).toBeGreaterThan(0);
        const meanY = (vertices: THREE.Vector3[]) => indices.reduce((sum, index) => sum + vertices[index]!.y, 0) / indices.length;
        expect(meanY(rest) - meanY(idle)).toBeGreaterThan(0.35);
      }
      avatar.sample(0, 3.2);
      const walkContact = new THREE.Box3().setFromPoints(skinnedVertices(avatar.group));
      expect(walkContact.min.y).toBeCloseTo(0, 5);
      expect(walkContact.max.y).toBeCloseTo(heightM, 5);
      expect(mesh.skeleton.boneInverses.map((matrix) => matrix.toArray())).toEqual(inverseBinds);
      expect(calculateInverses).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      avatar.dispose();
      asset.dispose();
      source.dispose();
      fixture.dispose();
    },
  );

  it('deforms walking CPU vertices independently per clone and applies caller transforms once', () => {
    const asset = createMannequin();
    const a = asset.instantiate(),
      b = asset.instantiate();
    a.sample(0, 0);
    b.sample(0, 0);
    const idleA = skinnedVertices(a.group),
      idleB = skinnedVertices(b.group);
    a.sample(0.17, 3.2);
    const walking = skinnedVertices(a.group);
    const changed = walking.filter((vertex, index) => vertex.distanceTo(idleA[index]!) > 0.01);
    expect(changed.length).toBeGreaterThan(100);
    expect(skinnedVertices(b.group)).toEqual(idleB);
    const bounds = new THREE.Box3().setFromPoints(walking);
    expect(bounds.max.y).toBeCloseTo(1.8, 5);
    expect(bounds.min.y).toBeGreaterThan(-0.1);
    expect(bounds.min.y).toBeLessThan(0.3);
    a.sample(10, 6);
    a.sample(0.17, 3.2);
    expect(skinnedVertices(a.group)).toEqual(walking);
    a.group.position.set(7, 2, -4);
    a.group.rotation.y = 0.7;
    a.group.scale.setScalar(1.25);
    a.sample(0.17, 3.2);
    const world = skinnedVertices(a.group);
    world.forEach((vertex, index) =>
      expect(vertex.distanceTo(walking[index]!.clone().applyMatrix4(a.group.matrixWorld))).toBeLessThan(1e-5),
    );
    expect(skinnedVertices(b.group)).toEqual(idleB);
    a.dispose();
    b.dispose();
    asset.dispose();
  });

  it('STU-2 snapshots canonical bones in world space after root and ancestor translation, yaw and scale change', () => {
    const asset = createMannequin();
    const avatar = asset.instantiate();
    avatar.sample(0.17, 3.2);
    const local = avatar.boneWorldPositions()!;
    expect(Object.keys(local).length).toBe(asset.report.boneCount);
    const parent = new THREE.Group();
    const ancestor = new THREE.Group();
    ancestor.add(parent);
    parent.add(avatar.group);
    ancestor.updateMatrixWorld(true);
    const transforms = [
      [avatar.group, [7, 2, -4], 0.7, [1.25, 1.5, 0.8]],
      [parent, [-3, 4, 2], -0.4, [0.75, 0.5, 1.2]],
      [ancestor, [10, -2, 5], 1.1, [2, 2, 2]],
    ] as const;
    const expectedMatrix = new THREE.Matrix4();
    for (const [node, position, yaw, scale] of transforms) {
      node.position.set(position[0], position[1], position[2]);
      node.rotation.y = yaw;
      node.scale.set(scale[0], scale[1], scale[2]);
      expectedMatrix.premultiply(new THREE.Matrix4().compose(node.position, node.quaternion, node.scale));
      const world = avatar.boneWorldPositions()!;
      for (const [name, point] of Object.entries(local)) {
        const expected = new THREE.Vector3(...point).applyMatrix4(expectedMatrix);
        expect(new THREE.Vector3(...world[name]!).distanceTo(expected)).toBeLessThan(1e-9);
      }
    }
    const nonbone = new THREE.Object3D();
    nonbone.name = 'mixamorigRightEye';
    const unknown = new THREE.Bone();
    unknown.name = 'mixamorigUnknown';
    avatar.group.getObjectByName('mixamorigHead')!.add(nonbone, unknown);
    const world = avatar.boneWorldPositions()!;
    expect(world).not.toHaveProperty(nonbone.name);
    expect(world).not.toHaveProperty(unknown.name);
    expect(Object.keys(world).every((name) => (avatar.group.getObjectByName(name) as THREE.Bone).isBone)).toBe(true);
    avatar.dispose();
    asset.dispose();
  });

  it('STU-2 bone snapshots are independent numeric arrays across reads, animation and avatar clones', () => {
    const asset = createMannequin();
    const a = asset.instantiate();
    const b = asset.instantiate();
    const first = a.boneWorldPositions()!;
    const second = a.boneWorldPositions()!;
    const other = b.boneWorldPositions()!;
    expect(first).toEqual(second);
    expect(first).toEqual(other);
    expect(first).not.toBe(second);
    for (const name of Object.keys(first)) {
      expect(Array.isArray(first[name])).toBe(true);
      expect(first[name]).toHaveLength(3);
      expect(first[name]!.every(Number.isFinite)).toBe(true);
      expect(first[name]).not.toBe(second[name]);
      expect(first[name]).not.toBe(other[name]);
    }
    first.mixamorigLeftHand![0] = 999;
    expect(a.boneWorldPositions()).toEqual(second);
    a.sample(0.17, 3.2);
    expect(a.boneWorldPositions()!.mixamorigLeftHand).not.toEqual(second.mixamorigLeftHand);
    expect(b.boneWorldPositions()).toEqual(other);
    expect(second).toEqual(other);
    a.dispose();
    b.dispose();
    asset.dispose();
  });

  it('normalizes colon-prefixed, loader-sanitized and unprefixed Mixamo bones without guessing arbitrary rigs', () => {
    expect(normalizeAvatarBoneName('mixamorig:Hips')).toBe('mixamorigHips');
    expect(normalizeAvatarBoneName('mixamorigLeftForeArm')).toBe('mixamorigLeftForeArm');
    expect(normalizeAvatarBoneName('LeftUpLeg')).toBe('mixamorigLeftUpLeg');
    expect(normalizeAvatarBoneName('unknown_joint_3')).toBe('unknown_joint_3');
  });

  it('shares geometry but owns independent skeletons, inverse binds and materials; defers asset disposal', () => {
    const asset = createMannequin();
    const a = asset.instantiate();
    const b = asset.instantiate();
    const ma = meshOf(a.group),
      mb = meshOf(b.group);
    expect(ma.geometry).toBe(mb.geometry);
    expect(ma.material).not.toBe(mb.material);
    expect(ma.skeleton).not.toBe(mb.skeleton);
    expect(ma.skeleton.bones[0]).not.toBe(mb.skeleton.bones[0]);
    expect(ma.skeleton.boneInverses[0]).not.toBe(mb.skeleton.boneInverses[0]);
    const original = pose(b.group);
    a.sample(0.17, 3);
    a.setTint(0xff0000);
    a.setOpacity(0.25);
    expect(pose(b.group)).toEqual(original);
    expect((mb.material as THREE.Material).opacity).toBe(1);
    const released = vi.fn();
    ma.geometry.addEventListener('dispose', released);
    asset.dispose();
    expect(() => asset.instantiate()).toThrow(/disposed/i);
    expect(released).not.toHaveBeenCalled();
    a.dispose();
    b.sample(9, 2);
    expect(released).not.toHaveBeenCalled();
    b.dispose();
    expect(released).toHaveBeenCalledTimes(1);
    b.dispose();
    asset.dispose();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('seeks procedural walking absolutely and never moves the caller-owned actor root', () => {
    const asset = createMannequin(),
      a = asset.instantiate();
    a.group.position.set(7, 2, -4);
    a.group.rotation.y = 0.7;
    a.sample(0.37, 3);
    const expected = pose(a.group);
    for (const t of [10, 0, 99, 0.1, 4]) a.sample(t, t, false);
    a.sample(0.37, 3);
    expect(pose(a.group)).toEqual(expected);
    expect(a.group.position.toArray()).toEqual([7, 2, -4]);
    expect(a.group.rotation.y).toBeCloseTo(0.7);
    const hips = a.group.getObjectByName('mixamorigHips')!;
    expect(hips.position.x).toBe(0);
    expect(hips.position.z).toBe(0);
    a.sample(0.63, 3);
    expect(pose(a.group)).not.toEqual(expected);
    a.dispose();
    asset.dispose();
  });

  it('normalizes names and animation bindings, keeps limb translation, removes planar root motion, seeks clips', () => {
    const fixture = createMannequin();
    const source = fixture.instantiate();
    source.sample(0, 0);
    source.group.traverse((node) => {
      if ((node as THREE.Bone).isBone) node.name = node.name.replace('mixamorig', 'mixamorig:');
    });
    const hips = source.group.getObjectByName('mixamorig:Hips')!;
    const arm = source.group.getObjectByName('mixamorig:LeftForeArm')!;
    const clip = new THREE.AnimationClip('Walk Forward', 1, [
      new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 8, 0, 5]),
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, hips.position.y, 0, 9, hips.position.y, -6]),
      new THREE.VectorKeyframeTrack(
        'mixamorig:LeftForeArm.position',
        [0, 1],
        [...arm.position.toArray(), arm.position.x + 0.1, arm.position.y, arm.position.z],
      ),
    ]);
    const asset = prepareAvatar(source.group, [clip], opts);
    expect(asset.report.clips).toEqual(['walk_forward']);
    const a = asset.instantiate();
    a.sample(0.5, 3);
    expect(a.group.getObjectByName('mixamorigHips')!.position.x).toBe(0);
    expect(a.group.getObjectByName('mixamorigHips')!.position.z).toBe(0);
    expect(a.group.getObjectByName('mixamorigLeftForeArm')!.position.x).toBeCloseTo(arm.position.x + 0.05);
    const expected = pose(a.group);
    a.sample(0.9, 0);
    a.sample(0.2, 6, false);
    a.sample(0.5, 3);
    expect(pose(a.group)).toEqual(expected);
    a.dispose();
    asset.dispose();
    source.dispose();
    fixture.dispose();
  });

  it('loads the same self-contained GLB bytes directly and from a credential-free bounded URL fetch', async () => {
    const fetcher = vi.fn(async () => new Response(triangleGlb()));
    vi.stubGlobal('fetch', fetcher);
    const direct = await loadAvatar(triangleGlb(), opts);
    const remote = await loadAvatar('https://assets.example/avatar.glb', opts);
    expect(direct.report).toEqual(remote.report);
    expect(direct.report.rig).toBe('unrigged');
    expect(direct.report.triangles).toBe(1);
    expect(direct.report.warnings.join(' ')).toMatch(/figurine/i);
    expect(fetcher.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ credentials: 'omit', redirect: 'error' })]);
    const a = direct.instantiate();
    expect(a.boneWorldPositions()).toBeNull();
    a.sample(0, 0);
    const expected = pose(a.group);
    a.sample(20, 6);
    expect(pose(a.group)).toEqual(expected);
    a.dispose();
    direct.dispose();
    remote.dispose();
  });

  it('normalizes centimetres, grounding and declared +Z facing without mirroring', () => {
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 180, 20), new THREE.MeshStandardMaterial());
    mesh.position.set(20, 120, 30);
    scene.add(mesh);
    const asset = prepareAvatar(scene, [], { ...opts, heightM: 1.7, forward: '+Z' });
    const a = asset.instantiate();
    const bounds = new THREE.Box3().setFromObject(a.group, true);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(1.7);
    expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0);
    const direction = new THREE.Vector3(0, 0, 1).transformDirection(a.group.getObjectByName('avatar_orientation')!.matrixWorld);
    expect(direction.z).toBeCloseTo(-1);
    expect(a.group.getObjectByName('avatar_orientation')!.matrixWorld.determinant()).toBeGreaterThan(0);
    a.dispose();
    asset.dispose();
  });

  it('enforces geometry and skeleton limits and does not claim arbitrary joints are Mixamo', () => {
    const heavy = new THREE.Group();
    heavy.add(new THREE.Mesh(new THREE.SphereGeometry(1, 256, 256), new THREE.MeshStandardMaterial()));
    expect(() => prepareAvatar(heavy, [], opts)).toThrow(/30000/);
    const tooMany = new THREE.Group();
    for (let i = 0; i < 81; i++) tooMany.add(new THREE.Bone());
    expect(() => prepareAvatar(tooMany, [], opts)).toThrow(/80 bone/);
    const fixture = createMannequin(),
      source = fixture.instantiate();
    meshOf(source.group).skeleton.bones.forEach((bone, i) => {
      bone.name = `joint_${i}`;
    });
    const unsupported = prepareAvatar(source.group, [], opts);
    expect(unsupported.report.rig).toBe('unsupported');
    const a = unsupported.instantiate();
    expect(a.boneWorldPositions()).toBeNull();
    const rest = pose(a.group);
    a.sample(0.35, 3);
    expect(pose(a.group)).toEqual(rest);
    a.dispose();
    unsupported.dispose();
    source.dispose();
    fixture.dispose();
  });

  it('rejects chunked streams over the cap without trusting Content-Length', async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(11 * 1024 * 1024));
              controller.enqueue(new Uint8Array(10 * 1024 * 1024));
            },
            cancel: cancelled,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(loadAvatar('https://assets.example/avatar.glb', opts)).rejects.toThrow(/20.*MB/i);
    expect(cancelled).toHaveBeenCalled();
  });

  it('preserves idle/walk/run clip names, gives unnamed and duplicate clips stable names, validates sample inputs', () => {
    const fixture = createMannequin(),
      source = fixture.instantiate();
    const clips = ['Idle', 'Walk', 'Run', '', 'Walk'].map(
      (name) =>
        new THREE.AnimationClip(name, 1, [new THREE.QuaternionKeyframeTrack('mixamorigHead.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]),
    );
    const asset = prepareAvatar(source.group, clips, opts);
    expect(asset.report.clips).toEqual(['idle', 'walk', 'run', 'clip_4', 'walk_2']);
    const a = asset.instantiate();
    expect(() => a.sample(NaN, 0)).toThrow(/finite/);
    expect(() => a.sample(0, -1)).toThrow(/nonnegative/);
    expect(() => a.setOpacity(2)).toThrow(/opacity/);
    expect(() => a.setTint(-1)).toThrow(/color/);
    a.dispose();
    asset.dispose();
    source.dispose();
    fixture.dispose();
  });

  it('wires the bundled meshopt decoder for an embedded buffer with a virtual fallback buffer', async () => {
    const decoded = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 2, 0]);
    const decoder = vi.spyOn(MeshoptDecoder, 'decodeGltfBufferAsync').mockResolvedValue(new Uint8Array(decoded.buffer));
    const data = glb(
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        extensionsUsed: ['EXT_meshopt_compression'],
        extensionsRequired: ['EXT_meshopt_compression'],
        buffers: [{ byteLength: 4 }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
        bufferViews: [
          {
            buffer: 1,
            byteLength: 36,
            extensions: {
              EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 4, count: 3, byteStride: 12, mode: 'ATTRIBUTES' },
            },
          },
        ],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 2, 0] }],
      },
      new ArrayBuffer(4),
    );
    const asset = await loadAvatar(data, opts);
    expect(asset.report.triangles).toBe(1);
    expect(decoder).toHaveBeenCalledWith(3, 12, expect.any(Uint8Array), 'ATTRIBUTES', undefined);
    asset.dispose();
  });

  it('rejects cyclic hierarchies and oversized embedded textures before Three allocates them', async () => {
    await expect(loadAvatar(glb({ asset: { version: '2.0' }, nodes: [{ children: [1] }, { children: [0] }] }), opts)).rejects.toThrow(
      /hierarchy/,
    );
    const png = new ArrayBuffer(24),
      view = new DataView(png);
    view.setUint32(0, 0x89504e47);
    view.setUint32(12, 0x49484452);
    view.setUint32(16, 100000);
    view.setUint32(20, 100000);
    await expect(
      loadAvatar(
        glb(
          {
            asset: { version: '2.0' },
            buffers: [{ byteLength: 24 }],
            bufferViews: [{ buffer: 0, byteLength: 24 }],
            images: [{ bufferView: 0, mimeType: 'image/png' }],
          },
          png,
        ),
        opts,
      ),
    ).rejects.toThrow(/texture.*4096/i);
  });

  it('rejects invalid data, external resources, decoder requirements, unsafe URLs and oversized downloads', async () => {
    await expect(loadAvatar(new ArrayBuffer(8), opts)).rejects.toThrow(/GLB/i);
    await expect(loadAvatar(new ArrayBuffer(20 * 1024 * 1024 + 1), opts)).rejects.toThrow(/20.*MB/i);
    await expect(loadAvatar(glb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://evil.test/a.bin' }] }), opts)).rejects.toThrow(
      /self-contained/i,
    );
    for (const extension of ['KHR_draco_mesh_compression', 'KHR_texture_basisu']) {
      await expect(loadAvatar(glb({ asset: { version: '2.0' }, extensionsUsed: [extension] }), opts)).rejects.toThrow(/Draco|KTX2/);
    }
    for (const url of [
      'file:///tmp/a.glb',
      'data:model/gltf-binary;base64,AA',
      'javascript:alert(1)',
      'http://example.com/a.glb',
      'https://u:p@example.com/a.glb',
    ]) {
      await expect(loadAvatar(url, opts)).rejects.toThrow(/URL|HTTPS|credentials/i);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(1), { headers: { 'content-length': String(21 * 1024 * 1024) } })),
    );
    await expect(loadAvatar('https://assets.example/a.glb', opts)).rejects.toThrow(/20.*MB/i);
    const flat = new THREE.Group();
    flat.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
    flat.rotation.x = Math.PI / 2;
    expect(() => prepareAvatar(flat, [], opts)).toThrow(/height/i);
    await expect(loadAvatar(triangleGlb(), { ...opts, heightM: NaN })).rejects.toThrow(/height/i);
  });
});
