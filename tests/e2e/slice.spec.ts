import { test, expect } from './fixtures';

/** Rendered-frame counter (the game bumps it once per drawn frame). */
const frame = () => (window as unknown as { __coastFrame?: number }).__coastFrame ?? 0;

/**
 * Vertical-slice loops (goal.md §3.1 steps 3–6): missions, takes, the lowrider. These record a clip with MediaRecorder,
 * which a software-GL browser only manages in a fresh process (the encoder dies after earlier captures), so each test
 * here runs in its own browser — see fixtures.ts.
 */
// Vertical-slice loop (goal.md §3.1 steps 4–6 / M3.5): mission briefed → Enter rolls (MediaRecorder + TakeRecorder) →
// Enter cuts → verdict with ★, hints and a downloadable clip; the take replays as a ghost.
test('mission slice: roll, cut, verdict, clip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&physics=1&cam=director&mission=1&tier=desktop');
  await page.waitForFunction(() => (window as unknown as { __coastPhysics?: boolean }).__coastPhysics === true, null, { timeout: 90_000 });
  await page.waitForSelector('.mc-title', { timeout: 30_000 });
  await expect(page.locator('.mc-state')).toContainText(/roll/i);
  const f0 = await page.evaluate(frame);
  await page.keyboard.press('Enter'); // action
  await expect(page.locator('.mc-state')).toContainText('REC', { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  // Record for rendered frames, not wall time: SwiftShader draws ~0.5 fps once the LoD is built, and the encoder needs a
  // handful of frames before it emits data. Every drawn frame is pushed to the clip (requestFrame), so ≥ 8 frames is enough.
  await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 8, f0, { timeout: 90_000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Enter'); // cut
  await page.waitForSelector('.mc-verdict', { timeout: 30_000 });
  await expect(page.locator('.mc-stars')).toHaveText(/^[★☆]{3}$/); // a short noon take off-subject scores ☆☆☆ — the judge works
  await expect(page.locator('.mc-hints')).toContainText(/take|frame|golden|camera/i);
  const download = page.locator('.mc-actions a[download]');
  await expect(download).toHaveCount(1, { timeout: 15_000 });
  expect(await download.getAttribute('href')).toMatch(/^blob:/);
  expect(errors, errors.join('\n')).toHaveLength(0);
});

// Lowrider (goal.md PHY-3): `vehicle=1` spawns the player in the driver's seat; W drives it, Space hops the front,
// E gets out. With `mission=2` the take is judged on hop timing (beatSync) with the car as the framing subject.
test('lowrider: drive, hop, judged on the beat, get out', async ({ page }) => {
  type V = NonNullable<Window['__coastVehicle']>;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&physics=1&cam=director&vehicle=1&mission=2&tier=desktop');
  await page.waitForFunction(() => (window as unknown as { __coastPhysics?: boolean }).__coastPhysics === true, null, { timeout: 90_000 });
  await expect(page.locator('.mc-title')).toContainText(/hop on the one/i);
  // Settled on all four wheels, in the driver's seat.
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { __coastVehicle?: V }).__coastVehicle;
      return !!v && v.driving && v.wheels === 4;
    },
    null,
    { timeout: 60_000 },
  );
  const start = (await page.evaluate(() => (window as unknown as { __coastVehicle: V }).__coastVehicle.pos)) as [number, number, number];
  await page.keyboard.press('Enter'); // roll
  await expect(page.locator('.mc-state')).toContainText('REC', { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => ((window as unknown as { __coastVehicle?: V }).__coastVehicle?.speed ?? 0) > 1.5, null, {
    timeout: 60_000,
  });
  // Keep the throttle down until it has clearly moved (the sim runs slower than wall time under SwiftShader).
  await page.waitForFunction(
    (s) => {
      const p = (window as unknown as { __coastVehicle?: V }).__coastVehicle?.pos;
      return !!p && Math.hypot(p[0] - s[0], p[2] - s[2]) > 1.5;
    },
    start,
    { timeout: 60_000 },
  );
  await page.keyboard.up('KeyW');
  const f1 = await page.evaluate(frame);
  await page.keyboard.press('Space'); // hop (a judged beat event)
  await page.waitForFunction(() => ((window as unknown as { __coastVehicle?: V }).__coastVehicle?.hops ?? 0) >= 1, null, {
    timeout: 30_000,
  });
  await page.waitForFunction((y0) => ((window as unknown as { __coastVehicle?: V }).__coastVehicle?.pos[1] ?? 0) > y0 + 0.1, start[1], {
    timeout: 30_000,
  });
  await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 8, f1, { timeout: 90_000 }); // enough drawn frames for a clip
  await page.keyboard.press('Enter'); // cut
  await page.waitForSelector('.mc-verdict', { timeout: 30_000 });
  await expect(page.locator('.mc-chips')).toContainText(/beat/i);
  await expect(page.locator('.mc-actions a[download]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.mc-stars')).toHaveText(/^[★☆]{3}$/);
  await page.keyboard.press('KeyE'); // get out
  await page.waitForFunction(() => (window as unknown as { __coastVehicle?: V }).__coastVehicle?.driving === false, null, {
    timeout: 15_000,
  });
  expect(errors, errors.join('\n')).toHaveLength(0);
});
