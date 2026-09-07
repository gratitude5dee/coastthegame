import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  Atmosphere,
  GRADES,
  TIME_ORDER,
  gradeState,
  lerpGradeState,
  sunDirection,
  weatherFog,
} from '../../packages/engine/src/world/grade';

/** goal.md W-5: time of day is a grade — four presets (+ noon), fog as a modifier, a sky, lights for the meshes. */
describe('grades (W-5)', () => {
  it('ships golden, blue hour, night and fog noon (plus a neutral noon), each complete', () => {
    expect(TIME_ORDER).toEqual(['noon', 'golden', 'blue', 'night', 'fog_noon']);
    for (const t of TIME_ORDER) {
      const g = GRADES[t];
      expect(g.tint.every((v) => v > 0 && v < 2)).toBe(true);
      expect(g.saturation).toBeGreaterThan(0);
      expect(g.fog.density).toBeGreaterThanOrEqual(0);
      expect(g.sun.intensity).toBeGreaterThan(0);
      expect(g.hemi.intensity).toBeGreaterThan(0);
    }
    expect(GRADES.noon.tint).toEqual([1, 1, 1]); // the neutral: the splats as scanned
    expect(GRADES.golden.tint[0]).toBeGreaterThan(GRADES.golden.tint[2]); // warm
    expect(GRADES.blue.tint[2]).toBeGreaterThan(GRADES.blue.tint[0]); // cool
    expect(GRADES.night.sky.stars).toBe(1);
    expect(GRADES.fog_noon.fog.density).toBeGreaterThan(GRADES.noon.fog.density * 4);
    expect(GRADES.night.neon).toBe(1);
  });

  it('weather adds fog density; the sun direction follows elevation / azimuth', () => {
    expect(weatherFog('clear')).toBe(0);
    expect(weatherFog('fog', 0)).toBeCloseTo(0.02, 6);
    expect(weatherFog('fog', 1)).toBeCloseTo(0.08, 6);
    expect(weatherFog('rain', 0.5)).toBeCloseTo(0.018, 6);
    expect(weatherFog('fog', 7)).toBeCloseTo(0.08, 6); // clamped
    const up = sunDirection(90, 0);
    expect(up.y).toBeCloseTo(1, 6);
    const east = sunDirection(0, 90);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.y).toBeCloseTo(0, 6);
    expect(sunDirection(-4, 255).y).toBeLessThan(0); // blue hour: below the horizon
  });

  it('a grade state lerps field by field and lands exactly at t = 1', () => {
    const a = gradeState(GRADES.noon);
    const b = gradeState(GRADES.night);
    const s = gradeState(GRADES.noon);
    lerpGradeState(s, b, 0.5);
    expect(s.tint.x).toBeCloseTo((a.tint.x + b.tint.x) / 2, 6);
    expect(s.fogDensity).toBeCloseTo((a.fogDensity + b.fogDensity) / 2, 6);
    expect(s.stars).toBeCloseTo(0.5, 6);
    expect(s.sunDir.length()).toBeCloseTo(1, 6); // re-normalised
    lerpGradeState(s, b, 1);
    expect(s.tint.toArray()).toEqual(b.tint.toArray());
    expect(s.zenith.getHex()).toBe(b.zenith.getHex());
    expect(s.sunIntensity).toBe(b.sunIntensity);
  });

  it('the atmosphere dissolves to a preset over its tween time and puts the same fog on the meshes', () => {
    const scene = new THREE.Scene();
    const atmo = new Atmosphere(scene, { tweenSeconds: 1 });
    const cam = new THREE.PerspectiveCamera();
    expect(scene.fog).toBe(atmo.fog);
    expect(scene.background).toBeNull();
    expect(scene.children).toContain(atmo.sky.mesh);
    expect(atmo.timeOfDay).toBe('noon');
    expect(atmo.tweening).toBe(false);
    atmo.setTime('golden');
    expect(atmo.tweening).toBe(true);
    atmo.update(1 / 60, cam);
    expect(atmo.state.tint.x).toBeGreaterThan(1); // on its way to warm
    expect(atmo.state.tint.x).toBeLessThan(GRADES.golden.tint[0]);
    for (let i = 0; i < 240; i++) atmo.update(1 / 60, cam);
    expect(atmo.tweening).toBe(false);
    expect(atmo.state.tint.toArray()).toEqual(GRADES.golden.tint);
    expect(atmo.sun.intensity).toBe(GRADES.golden.sun.intensity);
    expect(atmo.fog.density).toBeCloseTo(GRADES.golden.fog.density, 6);
    expect(atmo.fogColorHex).toBe(GRADES.golden.fog.color);
    // Weather stacks on the preset; `immediate` skips the dissolve (screenshots, `?time=`).
    atmo.setWeather('fog', 1, true);
    expect(atmo.tweening).toBe(false);
    expect(atmo.fog.density).toBeCloseTo(GRADES.golden.fog.density + 0.08, 6);
    atmo.setWeather('clear', 0, true);
    expect(atmo.fog.density).toBeCloseTo(GRADES.golden.fog.density, 6);
    // The sky follows the camera; the splat grade takes the same camera for its fog origin.
    cam.position.set(10, 2, -5);
    atmo.frame(cam);
    expect(atmo.sky.mesh.position.toArray()).toEqual([10, 2, -5]);
    atmo.dispose();
    expect(scene.fog).toBeNull();
    expect(scene.children).not.toContain(atmo.sky.mesh);
  });
});
