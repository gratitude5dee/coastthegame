import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraPath, type CameraKey } from '../../packages/engine/src/camera/path';
import { CameraRig } from '../../packages/engine/src/camera/cameraRig';
import { parseUtterance } from '../../packages/director/src/grammar';

/** goal.md CAM-7: keyframed camera paths — our own Catmull-Rom, time-keyed, scrubbable; CAM-2: the locked shot. */
const key = (t: number, x: number, y: number, z: number, fov = 50): CameraKey => ({ t, pos: [x, y, z], quat: [0, 0, 0, 1], fovDeg: fov });

describe('CameraPath', () => {
  it('keeps keys sorted by time, replaces a key at the same time, and re-times to a length', () => {
    const p = new CameraPath([key(2, 0, 0, 2), key(0, 0, 0, 0), key(1, 0, 0, 1)]);
    expect(p.keys.map((k) => k.t)).toEqual([0, 1, 2]);
    p.add(key(1, 5, 5, 5));
    expect(p.size).toBe(3);
    expect(p.keys[1]!.pos).toEqual([5, 5, 5]);
    expect(p.durationS).toBe(2);
    p.retime(6);
    expect(p.keys.map((k) => k.t)).toEqual([0, 3, 6]);
    expect(p.removeLast()?.t).toBe(6);
    expect(p.durationS).toBe(3);
  });

  it('passes through every key at its time, clamps outside, and eases between (smooth by default)', () => {
    const p = new CameraPath([key(0, 0, 0, 0, 40), key(2, 4, 0, 0, 60), key(4, 4, 0, 4, 60), key(6, 0, 0, 4, 40)]);
    for (const k of p.keys) {
      const s = p.sample(k.t);
      expect(s.pos.toArray().map((v) => +v.toFixed(6))).toEqual(k.pos);
      expect(s.fovDeg).toBe(k.fovDeg);
    }
    expect(p.sample(-1).pos.toArray()).toEqual([0, 0, 0]);
    expect(p.sample(99).pos.toArray()).toEqual([0, 0, 4]);
    // Mid-segment: between the keys, on the spline's side of the chord, fov halfway (smoothstep(0.5) = 0.5).
    const mid = p.sample(3);
    expect(mid.pos.x).toBeGreaterThan(4); // the centripetal spline bows outward around the corner
    expect(mid.pos.z).toBeCloseTo(2, 1);
    expect(mid.fovDeg).toBe(60);
    // Easing: a quarter into a segment, 'smooth' (ease-in) has moved less than 'linear' along the same spline.
    const smooth = p.sample(0.5);
    p.easing = 'linear';
    const linear = p.sample(0.5);
    expect(smooth.pos.x).toBeLessThan(linear.pos.x);
    expect(linear.pos.x).toBeGreaterThan(0.2);
    expect(linear.pos.x).toBeLessThan(2);
  });

  it('two keys move on a straight line; one key is a still; orientation slerps and fov lerps', () => {
    const q90: CameraKey['quat'] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const p = new CameraPath([key(0, 0, 1, 0, 30), { t: 2, pos: [10, 1, 0], quat: q90, fovDeg: 70 }], 'linear');
    const s = p.sample(1);
    expect(s.pos.toArray().map((v) => +v.toFixed(6))).toEqual([5, 1, 0]);
    expect(s.fovDeg).toBe(50);
    const e = new THREE.Euler().setFromQuaternion(s.quat, 'YXZ');
    expect(THREE.MathUtils.radToDeg(e.y)).toBeCloseTo(45, 4);
    const still = new CameraPath([key(0, 1, 2, 3)]);
    expect(still.sample(5).pos.toArray()).toEqual([1, 2, 3]);
    expect(still.durationS).toBe(0);
  });

  it('serialises keys as plain data and takes keys straight from a camera', () => {
    const cam = new THREE.PerspectiveCamera(35);
    cam.position.set(1, 2, 3);
    cam.rotation.y = Math.PI / 2;
    cam.updateMatrixWorld();
    const p = new CameraPath().addFromCamera(cam, 0.5);
    const json = JSON.parse(JSON.stringify(p.toJSON())) as CameraKey[];
    expect(json[0]).toMatchObject({ t: 0.5, pos: [1, 2, 3], fovDeg: 35 });
    expect(json[0]!.quat[1]).toBeCloseTo(Math.SQRT1_2, 5);
    const back = new CameraPath(json);
    expect(back.sample(0.5).pos.toArray()).toEqual([1, 2, 3]);
  });
});

describe('locked shot (CAM-2 on the rig)', () => {
  const target = { feet: new THREE.Vector3(), yaw: 0, eyeHeight: 1.6 };
  const look = { yaw: 0, pitch: 0, zoom: 1 };
  const step = (rig: CameraRig, cam: THREE.PerspectiveCamera, seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) rig.update(1 / 60, cam, target, look);
  };

  it('rides the path from its first key, hands the camera back at the end facing the way the path did', () => {
    const rig = new CameraRig('director');
    const cam = new THREE.PerspectiveCamera(50);
    step(rig, cam, 0.5);
    const path = new CameraPath([key(0, 0, 2, 10, 40), key(2, 0, 2, 0, 40)], 'linear');
    expect(rig.lock(path)).toBe(true);
    expect(rig.locked).toBe(true);
    step(rig, cam, 1); // 1 s in: halfway down the line
    expect(rig.pathTime).toBeCloseTo(1, 3);
    expect(cam.position.z).toBeCloseTo(5, 1);
    expect(cam.fov).toBe(40);
    step(rig, cam, 1.2); // past the end: released to the follow modes
    expect(rig.locked).toBe(false);
    expect(rig.pathTime).toBeNull();
    step(rig, cam, 1);
    expect(cam.position.z).not.toBeCloseTo(0, 0); // following the target again
  });

  it('scrubs and holds, plays again, loops, and refuses in actor mode', () => {
    const rig = new CameraRig('director');
    const cam = new THREE.PerspectiveCamera(50);
    const path = new CameraPath([key(0, 0, 0, 0), key(4, 8, 0, 0)], 'linear');
    rig.lock(path, { loop: true });
    rig.scrub(3);
    step(rig, cam, 0.5);
    expect(rig.pathTime).toBe(3); // held
    expect(cam.position.x).toBeCloseTo(6, 3);
    rig.play(2); // 2× speed
    step(rig, cam, 0.25);
    expect(rig.pathTime).toBeCloseTo(3.5, 2);
    step(rig, cam, 1); // wraps at 4 s
    expect(rig.locked).toBe(true);
    expect(rig.pathTime!).toBeLessThan(4);
    rig.unlock();
    expect(rig.locked).toBe(false);
    const actor = new CameraRig('actor');
    expect(actor.lock(path)).toBe(false);
    expect(rig.lock(new CameraPath())).toBe(false); // nothing to ride
  });
});

describe('the grammar knows the path words', () => {
  it('key / play / stop / clear / undo the last key', () => {
    expect(parseUtterance('set a key').acts[0]).toEqual({ op: 'camera', path: 'key' });
    expect(parseUtterance('keyframe').acts[0]).toEqual({ op: 'camera', path: 'key' });
    expect(parseUtterance('play the path').acts[0]).toEqual({ op: 'camera', path: 'play' });
    expect(parseUtterance('play the path in 8 seconds looped').acts[0]).toEqual({
      op: 'camera',
      path: 'play',
      path_seconds: 8,
      loop: true,
    });
    expect(parseUtterance('fly the path in 3.5s').acts[0]).toEqual({ op: 'camera', path: 'play', path_seconds: 3.5 });
    expect(parseUtterance('free camera').acts[0]).toEqual({ op: 'camera', path: 'stop' });
    expect(parseUtterance('release the camera').acts[0]).toEqual({ op: 'camera', path: 'stop' });
    expect(parseUtterance('clear the path').acts[0]).toEqual({ op: 'camera', path: 'clear' });
    expect(parseUtterance('drop the last key').acts[0]).toEqual({ op: 'camera', path: 'undo_key' });
    // Not confused with takes: "stop" alone still cuts, "replay" still replays the set.
    expect(parseUtterance('stop').acts[0]).toEqual({ op: 'record', action: 'stop' });
    expect(parseUtterance('replay').acts[0]?.op).toBe('replay_take');
  });
});
