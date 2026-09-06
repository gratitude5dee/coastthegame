import { test, expect } from './fixtures';

/**
 * WebXR path (goal.md CAM-3, CAM-4, INP-2) on the IWER emulated Quest 3 (`?xrsim=1`): enter VR, walk with the left
 * stick, snap-turn with the right stick, teleport by pushing it forward, flip to the diorama with B, leave. Runs
 * headless under SwiftShader — slow, so every wait is on game state, never wall-clock.
 *
 * Page-side helpers are installed with addInitScript (evaluate callbacks cannot close over Node-side functions).
 */
interface Helpers {
  feet(): [number, number, number];
  frameYaw(): number;
  worldScale(): number;
  cameraParented(): boolean;
  stick(hand: 'left' | 'right', x: number, y: number): void;
  button(hand: 'left' | 'right', id: string, v: number): void;
  /** Pitch the controller (radians, negative = point down). */
  aim(hand: 'left' | 'right', pitch: number): void;
  exit(): Promise<void>;
}
declare global {
  interface Window {
    __t: Helpers;
    __coastXr?: boolean;
    __coastXrSupported?: boolean;
    __coastDiorama?: boolean;
    __coastFrame?: number;
    __coastPhysics?: boolean;
  }
}

test('xr: enter, walk, snap-turn, teleport, diorama, exit — on the emulated Quest', async ({ page }) => {
  test.setTimeout(480_000); // stereo-less XR frames under SwiftShader still run at ~1 fps
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    type G = {
      character: { feet: () => { x: number; y: number; z: number } };
      localFrame: { rotation: { y: number } };
      world: { scale: { x: number } };
      camera: { parent: unknown };
      xr: { toggleXr: () => Promise<void> };
    };
    type Ctl = {
      updateAxes: (id: string, x: number, y: number) => void;
      updateButtonValue: (id: string, v: number) => void;
      quaternion: { set: (x: number, y: number, z: number, w: number) => void };
    };
    type Dev = { controllers: { left: Ctl; right: Ctl } };
    const w = window as unknown as { __coastGame?: G; __coastXrDevice?: Dev; __t: Helpers };
    const g = () => w.__coastGame!;
    w.__t = {
      feet: () => {
        const f = g().character.feet();
        return [f.x, f.y, f.z];
      },
      frameYaw: () => g().localFrame.rotation.y,
      worldScale: () => g().world.scale.x,
      cameraParented: () => g().camera.parent !== null,
      stick: (hand, x, y) => w.__coastXrDevice!.controllers[hand].updateAxes('thumbstick', x, y),
      button: (hand, id, v) => w.__coastXrDevice!.controllers[hand].updateButtonValue(id, v),
      aim: (hand, pitch) => w.__coastXrDevice!.controllers[hand].quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)),
      exit: () => g().xr.toggleXr(),
    };
  });
  await page.goto('/?scene=butterfly&physics=1&cam=director&xrsim=1&devui=0&tier=quest');
  await page.waitForFunction(() => window.__coastPhysics === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__coastXrSupported === true, null, { timeout: 30_000 });
  await expect(page.locator('#xr-button')).toHaveText('ENTER VR');

  // Enter VR (a user gesture on the button, like on the headset).
  await page.click('#xr-button');
  await page.waitForFunction(() => window.__coastXr === true, null, { timeout: 30_000 });
  await expect(page.locator('#xr-button')).toHaveText('EXIT VR');
  expect(await page.evaluate(() => window.__t.cameraParented())).toBe(true);
  const settle = async (n: number) => {
    const f0 = await page.evaluate(() => window.__coastFrame ?? 0);
    await page.waitForFunction(([f, k]) => (window.__coastFrame ?? 0) >= f + k, [f0, n] as const, { timeout: 90_000 });
  };
  await settle(3);

  // Walk: left stick forward until the capsule has moved.
  const p0 = await page.evaluate(() => window.__t.feet());
  await page.evaluate(() => window.__t.stick('left', 0, -1));
  await page.waitForFunction(
    (s) => {
      const f = window.__t.feet();
      return Math.hypot(f[0] - s[0], f[2] - s[2]) > 0.5;
    },
    p0,
    { timeout: 90_000 },
  );
  await page.evaluate(() => window.__t.stick('left', 0, 0));

  // Snap turn: one flick right = −30°, the frame turns, no repeat while held.
  const yaw0 = await page.evaluate(() => window.__t.frameYaw());
  await page.evaluate(() => window.__t.stick('right', 1, 0));
  await settle(3);
  await page.evaluate(() => window.__t.stick('right', 0, 0));
  await settle(2);
  const yaw1 = await page.evaluate(() => window.__t.frameYaw());
  expect(yaw1 - yaw0).toBeCloseTo(-Math.PI / 6, 3);

  // Teleport: point the right controller at the floor, push forward (aim), release (go) — the body jumps to the hit.
  const p1 = await page.evaluate(() => window.__t.feet());
  await page.evaluate(() => window.__t.aim('right', -0.75));
  await page.evaluate(() => window.__t.stick('right', 0, -1));
  await settle(3);
  await page.evaluate(() => window.__t.stick('right', 0, 0));
  await page.waitForFunction(
    (s) => {
      const f = window.__t.feet();
      return Math.hypot(f[0] - s[0], f[2] - s[2]) > 0.3;
    },
    p1,
    { timeout: 60_000 },
  );

  // Diorama: B shrinks the block onto the table (world group at 1:12) and pauses physics; B again restores it.
  await page.evaluate(() => window.__t.button('right', 'b-button', 1));
  await settle(2);
  await page.evaluate(() => window.__t.button('right', 'b-button', 0));
  await page.waitForFunction(() => window.__coastDiorama === true, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__t.worldScale())).toBeCloseTo(1 / 12, 6);
  await page.evaluate(() => window.__t.button('right', 'b-button', 1));
  await settle(2);
  await page.evaluate(() => window.__t.button('right', 'b-button', 0));
  await page.waitForFunction(() => window.__coastDiorama === false, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__t.worldScale())).toBe(1);

  // Leave VR: the camera is handed back to the desktop rig.
  await page.evaluate(() => window.__t.exit());
  await page.waitForFunction(() => window.__coastXr === false, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__t.cameraParented())).toBe(false);
  await expect(page.locator('#xr-button')).toHaveText('ENTER VR');
  expect(errors, errors.join('\n')).toHaveLength(0);
});
