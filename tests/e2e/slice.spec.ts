import { test, expect } from './fixtures';
import { writeFileSync } from 'node:fs';

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
  test.setTimeout(600_000); // two clips + two exports on software GL: the second clip crawls (see below)
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
  // Multi-take blocking (ACT-2): the take joined the set and loops as a ghost; take 2 rolls with it performing.
  type S = NonNullable<Window['__coastStudio']>;
  await page.waitForFunction(
    () =>
      (window as unknown as { __coastStudio?: S }).__coastStudio?.setSize === 1 &&
      (window as unknown as { __coastStudio?: S }).__coastStudio?.ghosts === 1,
    null,
    { timeout: 15_000 },
  );
  await page.locator('.mc-actions button', { hasText: /take/i }).first().click(); // retake
  await expect(page.locator('.mc-state')).toContainText(/Take 2/i);
  const f1 = await page.evaluate(frame);
  await page.keyboard.press('Enter'); // roll take 2
  // Take 1 performs again (a ghost on the take clock) while take 2 rolls. A second capture crawls on software GL (the
  // encoder starves the 2-core renderer: a frame every ~15 s), so from here the waits are generous and frame-free.
  await page.waitForFunction(
    () =>
      (window as unknown as { __coastStudio?: S }).__coastStudio?.state === 'recording' &&
      (window as unknown as { __coastStudio?: S }).__coastStudio?.ghosts === 1,
    null,
    { timeout: 60_000 },
  );
  // A take needs two samples to join the set: let a few frames render before the cut (the post stack makes a frame dearer).
  await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 4, f1, {
    timeout: 120_000,
  });
  await page.keyboard.press('Enter'); // cut
  await page.waitForSelector('.mc-verdict', { timeout: 120_000 });
  await page.waitForFunction(() => (window as unknown as { __coastStudio?: S }).__coastStudio?.setSize === 2, null, { timeout: 60_000 });
  // Cut export (STU-3): the set re-renders at a fixed step into an MP4 through WebCodecs + Mediabunny — a small one
  // here (the first bar at 10 fps, 320×180) so software GL finishes in seconds.
  const cut = await page.evaluate(() => window.__coastExport!({ width: 320, height: 180, fps: 10, bars: [1, 1] }));
  expect(cut.frames).toBe(26); // one bar at 92 bpm = 2.6 s
  // The provenance manifest (STU-5) travels with the cut: both takes, the cell, the shot, the file's hash.
  const manifest = cut.manifest as {
    v: number;
    kind: string;
    takeDetails: { actorId: string }[];
    cells: { id: string }[];
    shot: { frames: number; fps: number; bars?: [number, number]; look?: string };
    video?: { bytes: number; sha256?: string };
    app: { version: string; commit?: string };
  };
  expect(manifest).toMatchObject({ v: 1, kind: 'coast-cut' });
  expect(manifest.takeDetails.map((t) => t.actorId)).toEqual(['player', 'player']);
  expect(manifest.cells[0]!.id).toBe('butterfly');
  expect(manifest.shot).toMatchObject({ frames: 26, fps: 10, bars: [1, 1], look: '35mm-dusk' });
  expect(manifest.video?.bytes).toBe(cut.bytes);
  expect(manifest.video?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(manifest.app.version).toMatch(/^\d+\.\d+\.\d+$/);
  // A portrait cut (9:16) composes the same frames tall — the camera's vertical field stays, the sides crop.
  const tall = await page.evaluate(() => window.__coastExport!({ width: 90, height: 160, fps: 5, bars: [1, 1] }));
  expect(tall.frames).toBe(13);
  expect(tall.bytes).toBeGreaterThan(500);
  expect(cut.bytes).toBeGreaterThan(2000);
  expect(cut.mime).toMatch(/^video\/(mp4|webm)/);
  // Control passes (STU-2) for a faithful render: depth + pose videos and camera.json for a ≤ 5 s span at ≤ 720p —
  // the first second here, at 5 fps, so software GL finishes in seconds.
  const control = await page.evaluate(() => window.__coastExportControl!({ startS: 0, endS: 1, fps: 5, preview: true }));
  for (const pass of ['depth', 'pose'] as const) {
    const png = control.preview?.[pass];
    expect(png).toMatch(/^data:image\/png;base64,/);
    writeFileSync(`tests/e2e/__screenshots__/control-${pass}.png`, Buffer.from(png!.replace(/^data:image\/png;base64,/, ''), 'base64')); // human-viewable
  }
  expect(control.passes.depth).toMatchObject({ frames: 5, seconds: 1 });
  expect(control.passes.pose).toMatchObject({ frames: 5, seconds: 1 });
  expect(control.passes.depth!.bytes).toBeGreaterThan(500);
  expect(control.passes.pose!.bytes).toBeGreaterThan(200);
  expect(control.passes.depth!.mime).toMatch(/^video\/(mp4|webm)/);
  expect(control.camera).toMatchObject({ frames: 5, width: 1280, height: 720, near: 0.25, far: 60 });
  expect(control.camera.first).toMatchObject({ t: 0, cx: 640, cy: 360 });
  expect((control.camera.first as { fy: number }).fy).toBeGreaterThan(300);
  await expect(page.locator('.mc-state')).toBeVisible(); // the live loop resumed (the card keeps updating)
  // The reel (MIS-4): the mission's slot is filled and its button plays the best take back.
  await expect(page.locator('#coast-reel')).toBeVisible();
  // Bars fill only for a ≥ 1★ verdict: the mission's eight bars, or none. (Which of the two this short noon take earns
  // depends on where the ground put the crate — the reel's rule is what is under test.)
  // (The card may already show the next brief by now — the Photographer moves on — so read the stars off the reel.)
  const reelButton = page.locator('#coast-reel button[data-mission="m01-low-and-slow"]');
  await expect(reelButton).toBeEnabled();
  const stars = ((await reelButton.textContent()) ?? '').split('★').length - 1;
  await expect(page.locator('#coast-reel .rl-bar.earned')).toHaveCount(stars >= 1 ? 8 : 0);
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

// Spray paint (goal.md W-4, golden path step 3): holding a can, a click at the splats lays an SDF puff in the can's
// colour; Z undoes the stroke. The click lands on the butterfly's projected bounding-box centre, so no pixel guessing.
test('spray paint: click tags the splats, undo clears it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&physics=1&cam=director&grab=can_3&tier=desktop');
  await page.waitForFunction(() => (window as unknown as { __coastPhysics?: boolean }).__coastPhysics === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => (window as unknown as { __coastLod?: boolean }).__coastLod === true, null, { timeout: 90_000 });
  await expect(page.locator('#hud')).toContainText(/spray/i, { timeout: 30_000 });
  // Let the LoD raycast index fill in (a few frames), then aim at the mesh origin (the butterfly sits on it).
  const f0 = await page.evaluate(() => (window as unknown as { __coastFrame?: number }).__coastFrame ?? 0);
  await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 4, f0, { timeout: 90_000 });
  const target = await page.evaluate(() => {
    type V = { clone: () => V; project: (c: unknown) => { x: number; y: number } };
    const g = (window as unknown as { __coastGame: { splat: { position: V }; camera: unknown } }).__coastGame;
    const ndc = g.splat.position.clone().project(g.camera);
    return { x: ((ndc.x + 1) / 2) * innerWidth, y: ((1 - ndc.y) / 2) * innerHeight };
  });
  const count = () => page.evaluate(() => (window as unknown as { __coastPaint?: { count: number } }).__coastPaint?.count ?? 0);
  // One click = one puff. The LoD raycast index can lag a frame or two, so click until the first puff lands.
  let puffs = 0;
  for (let i = 0; i < 6 && puffs === 0; i++) {
    await page.mouse.click(Math.round(target.x), Math.round(target.y));
    const f1 = await page.evaluate(() => (window as unknown as { __coastFrame?: number }).__coastFrame ?? 0);
    await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 2, f1, {
      timeout: 60_000,
    });
    puffs = await count();
  }
  expect(puffs).toBeGreaterThanOrEqual(1);
  // Z undoes a stroke at a time.
  for (let i = 0; i < 8 && (await count()) > 0; i++) {
    await page.keyboard.press('KeyZ');
    const f2 = await page.evaluate(() => (window as unknown as { __coastFrame?: number }).__coastFrame ?? 0);
    await page.waitForFunction((f) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= f + 2, f2, {
      timeout: 60_000,
    });
  }
  expect(await count()).toBe(0);
  expect(errors, errors.join('\n')).toHaveLength(0);
});
