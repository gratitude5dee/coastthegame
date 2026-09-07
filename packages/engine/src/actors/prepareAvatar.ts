import * as THREE from 'three';
import { AvatarAsset, type AvatarOptions, type AvatarReport } from './avatar';

const core = [
  'Hips',
  'Spine',
  'Head',
  ...['Left', 'Right'].flatMap((side) => ['Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot'].map((part) => `${side}${part}`)),
];
const names = new Set([
  ...core,
  'Spine1',
  'Spine2',
  'Neck',
  ...['Left', 'Right'].flatMap((side) =>
    [
      'Shoulder',
      'ToeBase',
      'Eye',
      ...['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((finger) => [1, 2, 3, 4].map((i) => `Hand${finger}${i}`)),
    ].map((part) => `${side}${part}`),
  ),
]);

export function normalizeAvatarBoneName(name: string): string {
  const base = name.replace(/^mixamorig[:_]?/i, '');
  const standard = [...names].find((candidate) => candidate.toLowerCase() === base.toLowerCase());
  return standard ? `mixamorig${standard}` : name;
}

export function validateAvatarOptions(opts: AvatarOptions): void {
  if (
    !opts ||
    typeof opts.id !== 'string' ||
    !opts.id.trim() ||
    opts.id.length > 160 ||
    typeof opts.name !== 'string' ||
    !opts.name.trim() ||
    opts.name.length > 160
  )
    throw new Error('Avatar id and name must be nonempty strings of at most 160 characters.');
  if (opts.forward !== undefined && opts.forward !== '+Z' && opts.forward !== '-Z') throw new Error('Avatar forward must be +Z or -Z.');
  if (opts.heightM !== undefined && (!Number.isFinite(opts.heightM) || opts.heightM < 0.5 || opts.heightM > 3))
    throw new Error('Avatar height must be between 0.5 and 3 metres.');
}

export function prepareAvatar(scene: THREE.Group, animations: THREE.AnimationClip[], opts: AvatarOptions): AvatarAsset {
  validateAvatarOptions(opts);
  if (scene.parent) throw new Error('Avatar preparation requires a detached scene and transfers ownership of its resources.');
  const nodes: THREE.Object3D[] = [];
  scene.traverse((node) => nodes.push(node));
  if (nodes.length > 2048) throw new Error('Avatar has too many scene nodes (maximum 2048).');
  const bones = nodes.filter((node): node is THREE.Bone => (node as THREE.Bone).isBone);
  if (bones.length > 80) throw new Error('Avatar exceeds the 80 bone limit.');
  const nodeSet = new Set(nodes);
  const aliases = new Map<string, THREE.Object3D>();
  const usedNames = new Set<string>();
  const warnings: string[] = [];
  let duplicateBones = false;
  let triangles = 0;
  let skins = 0;
  for (const [i, node] of nodes.entries()) {
    if (
      ![...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray(), ...node.matrix.elements].every(Number.isFinite)
    )
      throw new Error('Avatar contains a non-finite transform.');
    if (node.scale.x <= 0 || node.scale.y <= 0 || node.scale.z <= 0)
      throw new Error('Avatar has mirrored or zero scale; bake positive transforms before export.');
    const original = node.name;
    const bone = (node as THREE.Bone).isBone;
    const normalized = THREE.PropertyBinding.sanitizeNodeName(bone ? normalizeAvatarBoneName(original) : original) || `avatar_node_${i}`;
    if (usedNames.has(normalized) && bone) duplicateBones = true;
    node.name = usedNames.has(normalized) ? `${normalized}_${i}` : normalized;
    usedNames.add(node.name);
    for (const alias of [node.uuid, original, THREE.PropertyBinding.sanitizeNodeName(original), normalized]) {
      if (alias && !aliases.has(alias)) aliases.set(alias, node);
    }
    if (!(node as THREE.Mesh).isMesh) continue;
    const mesh = node as THREE.Mesh;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh)
      throw new Error('Instanced avatar meshes are unsupported; export ordinary skinned meshes.');
    const positions = mesh.geometry.getAttribute('position');
    if (!positions || positions.itemSize !== 3) throw new Error('Avatar mesh needs vertex positions.');
    triangles += (mesh.geometry.index?.count ?? positions.count) / 3;
    if (triangles > 30000) throw new Error('Avatar exceeds the 30000 triangle limit.');
    for (let j = 0; j < positions.count; j++) {
      if (![positions.getX(j), positions.getY(j), positions.getZ(j)].every(Number.isFinite))
        throw new Error('Avatar contains non-finite vertex positions.');
    }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      skins++;
      const skeleton = (mesh as THREE.SkinnedMesh).skeleton;
      if (!skeleton || skeleton.bones.some((b) => !nodeSet.has(b))) throw new Error('Avatar skeleton references bones outside its scene.');
      const indices = mesh.geometry.getAttribute('skinIndex');
      const weights = mesh.geometry.getAttribute('skinWeight');
      if (
        !indices ||
        !weights ||
        indices.itemSize !== 4 ||
        weights.itemSize !== 4 ||
        indices.count !== positions.count ||
        weights.count !== positions.count
      )
        throw new Error('Avatar has invalid skin attributes.');
      for (let j = 0; j < indices.count; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const index = indices.getComponent(j, k),
            weight = weights.getComponent(j, k);
          if (!Number.isInteger(index) || index < 0 || index >= skeleton.bones.length || !Number.isFinite(weight) || weight < 0)
            throw new Error('Avatar has invalid skin weights or bone indices.');
          sum += weight;
        }
        if (Math.abs(sum - 1) > 0.02) throw new Error('Avatar skin weights must sum to one.');
      }
      if (skeleton.boneInverses.some((matrix) => !matrix.elements.every(Number.isFinite)))
        throw new Error('Avatar has invalid inverse bind matrices.');
    }
  }
  if (triangles < 1 || !Number.isInteger(triangles)) throw new Error('Avatar needs a nonempty triangle mesh.');
  const boneNames = new Set(bones.map((bone) => bone.name));
  let rig: AvatarReport['rig'] = skins ? 'unsupported' : 'unrigged';
  if (skins && !duplicateBones && core.every((name) => boneNames.has(`mixamorig${name}`))) {
    const descends = (child: string, ancestor: string) => {
      let node = scene.getObjectByName(`mixamorig${child}`)?.parent;
      while (node) {
        if (node.name === `mixamorig${ancestor}`) return true;
        node = node.parent;
      }
      return false;
    };
    if (
      ['Left', 'Right'].every(
        (side) =>
          descends(`${side}Hand`, `${side}ForeArm`) &&
          descends(`${side}ForeArm`, `${side}Arm`) &&
          descends(`${side}Arm`, 'Spine') &&
          descends(`${side}Foot`, `${side}Leg`) &&
          descends(`${side}Leg`, `${side}UpLeg`) &&
          descends(`${side}UpLeg`, 'Hips'),
      ) &&
      descends('Spine', 'Hips') &&
      descends('Head', 'Spine')
    )
      rig = 'mixamo';
  }
  if (rig === 'mixamo')
    warnings.push(
      'Procedural gait assumes a Y-up Mixamo humanoid rest pose; bone naming is not universal rig retargeting. Fingers, facial motion, foot IK and authored performance retargeting are not synthesized.',
    );
  if (rig === 'unsupported')
    warnings.push(
      'Unsupported rig: native named locomotion clips can play, but no procedural retargeting is attempted. Export a Mixamo-spec humanoid rig for the fallback gait.',
    );
  if (rig === 'unrigged') warnings.push('Unrigged figurine: no skeletal walking is synthesized.');
  warnings.push(`Forward is declared ${opts.forward ?? '+Z'} and normalized to -Z; orientation is not inferred from appearance.`);
  scene.updateMatrixWorld(true);
  const motionRoots = new Set<THREE.Object3D>();
  for (const bone of bones) {
    if (bone.name === 'mixamorigHips' || !(bone.parent as THREE.Bone)?.isBone) {
      let node: THREE.Object3D | null = bone;
      while (node) {
        motionRoots.add(node);
        node = node.parent;
      }
    }
  }
  if (!bones.length) nodes.filter((node) => !(node as THREE.Mesh).isMesh || node.parent === scene).forEach((node) => motionRoots.add(node));
  const clipNames = new Set<string>();
  if (animations.length > 128) throw new Error('Avatar has too many clips (maximum 128).');
  const clips = animations
    .map((source, i) => {
      const clip = source.clone();
      const base =
        source.name
          .trim()
          .toLowerCase()
          .replace(/^mixamo(?:rig)?[|:_\s]*/, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '') || `clip_${i + 1}`;
      clip.name = base;
      for (let n = 2; clipNames.has(clip.name); n++) clip.name = `${base}_${n}`;
      clipNames.add(clip.name);
      if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 3600 || clip.tracks.length > 512)
        throw new Error('Avatar clip has invalid duration or too many tracks.');
      clip.tracks = clip.tracks.flatMap((track) => {
        if (!track.validate() || !Array.from(track.times).every(Number.isFinite) || !Array.from(track.values).every(Number.isFinite))
          throw new Error('Avatar clip contains invalid keyframes.');
        const binding = THREE.PropertyBinding.parseTrackName(track.name);
        const targetName = binding.objectName === 'bones' ? String(binding.objectIndex) : (binding.nodeName ?? '');
        const target =
          aliases.get(targetName) ??
          aliases.get(normalizeAvatarBoneName(targetName)) ??
          (targetName === '' || targetName === '.' ? scene : undefined);
        if (
          !target ||
          !['position', 'quaternion', 'scale', 'morphTargetInfluences'].includes(binding.propertyName) ||
          (binding.objectName && binding.objectName !== 'bones')
        ) {
          warnings.push(`Skipped unsupported animation binding: ${track.name}`);
          return [];
        }
        track.name = `${target.name}.${binding.propertyName}${binding.propertyIndex !== undefined ? `[${binding.propertyIndex}]` : ''}`;
        if (motionRoots.has(target) && binding.propertyName === 'position') {
          if (track.getValueSize() !== 3 || binding.propertyIndex !== undefined) {
            warnings.push(`Removed unsupported root translation track: ${track.name}`);
            return [];
          }
          const up = new THREE.Vector3(0, 1, 0);
          if (target.parent) up.applyQuaternion(target.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
          const rest = target.position;
          const value = new THREE.Vector3();
          for (let j = 0; j < track.values.length; j += 3) {
            value.fromArray(track.values, j).sub(rest);
            const vertical = value.dot(up);
            value.copy(up).multiplyScalar(vertical).add(rest).toArray(track.values, j);
          }
        }
        if (motionRoots.has(target) && target.name !== 'mixamorigHips' && ['quaternion', 'scale'].includes(binding.propertyName)) {
          warnings.push(`Removed animated root orientation/scale: ${track.name}`);
          return [];
        }
        return [track];
      });
      return clip;
    })
    .filter((clip) => clip.tracks.length > 0);
  if (animations.length)
    warnings.push(
      'Only native idle/walk/run/fall named clips are selected by sample(); other clips are reported but require a future explicit performance API. Root planar translation is removed; limb tracks remain intact.',
    );
  const orientation = new THREE.Group();
  orientation.name = 'avatar_orientation';
  orientation.rotation.y = (opts.forward ?? '+Z') === '+Z' ? Math.PI : 0;
  orientation.add(scene);
  orientation.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(orientation, true);
  const size = box.getSize(new THREE.Vector3());
  if (
    ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite) ||
    size.y < 0.0001 ||
    size.y > 10000 ||
    Math.max(size.x, size.z) > size.y * 10
  ) {
    orientation.remove(scene);
    throw new Error('Avatar height/bounds are invalid; export a finite Y-up character (height 0.0001–10000 source units).');
  }
  const heightM = opts.heightM ?? 1.8;
  const scale = heightM / size.y;
  const template = new THREE.Group();
  template.name = 'avatar_normalized';
  template.scale.setScalar(scale);
  template.position.set(-(box.min.x + box.max.x) * 0.5 * scale, -box.min.y * scale, -(box.min.z + box.max.z) * 0.5 * scale);
  template.add(orientation);
  template.updateMatrixWorld(true);
  return new AvatarAsset(
    template,
    clips,
    { boneCount: bones.length, triangles, heightM, clips: clips.map((clip) => clip.name), rig, warnings: [...new Set(warnings)] },
    opts,
  );
}
