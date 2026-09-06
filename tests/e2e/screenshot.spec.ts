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
  // Loading choreography (UX-3): the title card wipes away once fetch + detail + physics are in — never a stuck screen.
  await expect(page.locator('#coast-load')).toBeHidden({ timeout: 60_000 });
});
