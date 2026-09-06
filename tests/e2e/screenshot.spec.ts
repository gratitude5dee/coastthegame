import { test, expect } from '@playwright/test';

/**
 * Deterministic screenshot harness (AGENTS.md §2.4). `tier=desktop` forces desktop budgets under SwiftShader
 * (which would otherwise detect as 'fallback'); `shot=1` freezes time at `t`. Baselines are Linux-only
 * (CI + Codex sandboxes); `maxDiffPixelRatio` absorbs driver-level noise. Update with `--update-snapshots`
 * only in a PR that explains the visual change (art/DIFF.md).
 */
const SHOTS = [
  { name: 'butterfly-director-t0', url: '/?scene=butterfly&cam=director&t=0&shot=1&tier=desktop' },
  { name: 'butterfly-actor-t2', url: '/?scene=butterfly&cam=actor&t=2&shot=1&tier=desktop' },
];

for (const shot of SHOTS) {
  test(`renders ${shot.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(shot.url);
    await page.waitForFunction(() => (window as unknown as { __coastReady?: boolean }).__coastReady === true, null, { timeout: 90_000 });
    // Settle deterministically: LoD tree built, then 3 more rendered frames (sort converges), not wall-clock.
    // SwiftShader renders post-LoD frames at ~0.3–1 fps at 720p, so this stays cheap while being stable.
    await page.waitForFunction(() => (window as unknown as { __coastLod?: boolean }).__coastLod === true, null, { timeout: 90_000 });
    const start = (await page.evaluate(() => (window as unknown as { __coastFrame?: number }).__coastFrame)) ?? 0;
    await page.waitForFunction((s) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= s + 3, start, {
      timeout: 90_000,
    });
    await page.screenshot({ path: `tests/e2e/__screenshots__/${shot.name}.png` }); // human-viewable copy
    // toHaveScreenshot captures twice and requires stability; SwiftShader needs a long timeout. HUD text is masked.
    await expect(page).toHaveScreenshot(`${shot.name}.png`, { maxDiffPixelRatio: 0.02, timeout: 120_000, mask: [page.locator('#hud')] });
    expect(errors, errors.join('\n')).toHaveLength(0);
    expect(await page.locator('#hud').innerText()).toContain('tier desktop');
    // Guard against a silently empty frame (e.g. Spark auto-detection broken by `fileType: undefined`).
    // The HUD refreshes every 10 frames (slow under SwiftShader), so poll it rather than reading once.
    await page.waitForFunction(
      () => {
        const t = document.getElementById('hud')?.innerText ?? '';
        return Number((t.match(/splats ([\d,]+)/)?.[1] ?? '0').replace(/,/g, '')) > 1000;
      },
      null,
      { timeout: 60_000 },
    );
  });
}

// The bare landing URL (no params) must boot — a regression here shipped as "stuck at loading" (rig-mode lookup on null).
test('boots the bare landing URL without page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?tier=desktop');
  await page.waitForFunction(
    () =>
      (window as unknown as { __coastFrame?: number }).__coastFrame !== undefined &&
      (window as unknown as { __coastFrame: number }).__coastFrame > 5,
    null,
    { timeout: 60_000 },
  );
  expect(errors, errors.join('\n')).toHaveLength(0);
  expect(await page.locator('#hud').innerText()).toContain('playground');
});

// Physics smoke (goal.md PHY-1/ACT-1): Rapier loads on demand, the ground grid is derived from the splats, and the
// character steps at 60 Hz — verified headless on the local sample with `physics=1`.
test('physics smoke: rapier + character controller step without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&physics=1&cam=director&tier=desktop');
  await page.waitForFunction(() => (window as unknown as { __coastPhysics?: boolean }).__coastPhysics === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => ((window as unknown as { __coastSteps?: number }).__coastSteps ?? 0) > 30, null, { timeout: 60_000 });
  // Walk forward for a moment and confirm the loop keeps stepping.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Tab'); // mode cycle (QB-4 marks)
  await page.waitForFunction(() => ((window as unknown as { __coastSteps?: number }).__coastSteps ?? 0) > 60, null, { timeout: 60_000 });
  expect(errors, errors.join('\n')).toHaveLength(0);
  expect(await page.locator('#hud').innerText()).toContain('physics');
  // The ground came from the splats (LoD data lives in packedSplats.lodSplats — a regression here reads 0 splats and
  // leaves a flat y=0 plane). The butterfly is ~1 m wide, so only a handful of 0.75 m cells carry real samples.
  const ground = await page.evaluate(() => window.__coastGround);
  expect(ground?.sampled ?? 0).toBeGreaterThan(0);
  // Loading choreography (UX-3): the title card wipes away once fetch + detail + physics are in — never a stuck screen.
  await expect(page.locator('#coast-load')).toBeHidden({ timeout: 60_000 });
  // NPCs (PHY-4): the navmesh bakes from the ground grid, the Photographer walks up and says her line (subtitle).
  await page.waitForFunction(() => (window.__coastNpcs?.count ?? 0) >= 4 && window.__coastNpcs?.nav === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__coastNpcs?.greets ?? 0) >= 1, null, { timeout: 90_000 });
  await expect(page.locator('#coast-sub')).toContainText(/Photographer/i);
  // Possession (ACT-3): V swaps bodies with the Photographer (she is within reach after her greeting); V again, next to
  // the body that now carries $COAST, switches back.
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.__coastStudio?.actorId === 'photographer', null, { timeout: 30_000 });
  await expect(page.locator('#coast-sub')).toContainText(/Photographer now/i);
  expect(await page.evaluate(() => window.__coastNpcs?.photographer)).toBeNull(); // the identity left the crowd
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.__coastStudio?.actorId === 'player' && window.__coastStudio.possessed === 2, null, {
    timeout: 30_000,
  });
  // The director's console (DIR-1/DIR-2): a typed direction runs the same acts the voice model will call as tools.
  const directed = await page.evaluate(() => window.__coastSay!('camera low, follow the car, golden hour').results.map((r) => r.ok));
  expect(directed).toEqual([true, true, true]);
  await page.waitForFunction(
    () => window.__coastDirector?.follow === 'lowrider' && (window.__coastDirector?.shot.height ?? 9) < 0.6,
    null,
    {
      timeout: 30_000,
    },
  );
  await expect(page.locator('#coast-sub')).toContainText('✓ camera low');
  expect(await page.locator('#hud').innerText()).toContain('time golden');
  // "move the ball next to the car": a described object, a relative place — no pointing needed.
  const moved = await page.evaluate(() => {
    const r = window.__coastSay!('move the ball next to the car').results[0]!;
    const g = window.__coastGame as {
      props: { props: Map<string, { mesh: { position: { x: number; z: number } } }> };
      vehicle: { position(): { x: number; z: number } };
    };
    const p = g.props.props.get(r.affected[0] ?? '')?.mesh.position;
    const car = g.vehicle.position();
    return { ok: r.ok, id: r.affected[0], d: p ? Math.hypot(p.x - car.x, p.z - car.z) : Infinity };
  });
  expect(moved.ok).toBe(true);
  expect(moved.id).toMatch(/^ball/);
  expect(moved.d).toBeLessThan(6);
  // Ambiguity asks instead of acting: two crates match "the crate".
  const asked = await page.evaluate(() => window.__coastSay!('delete the crate').results[0]);
  expect(asked?.ok).toBe(false);
  expect(asked?.question).toBe('this one?');
  // The `/` bar: keys go to the input, not the character; Enter directs.
  await page.keyboard.press('Slash');
  await expect(page.locator('#coast-say')).toBeVisible();
  await page.keyboard.type('pull out');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__coastDirector?.text === 'pull out' && window.__coastDirector.ok[0] === true, null, {
    timeout: 30_000,
  });
  await expect(page.locator('#coast-say')).toBeHidden();
  expect(errors, errors.join('\n')).toHaveLength(0);
});
