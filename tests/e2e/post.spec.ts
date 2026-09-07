import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * The post stack (goal.md W-5 "post LUT", MIS-6 "the mission names the look", AF-7 `postprocessing`): on for the
 * desktop tier, the look's LUT on the finished picture, bloom with the neon. `screenshot.spec.ts` is the other half of
 * this — its baselines were made without the stack, so a `clean` look at noon passing them proves the display-referred
 * buffer (ADR-0010) hands the canvas the same pixels; the last test here makes that exact — the same frame through the
 * stack and straight to the canvas, byte for byte. Also: a look changes the picture (noir → no chroma) and goes away
 * again, night brings the bloom pass in, `?post=0` renders straight to the canvas.
 */
/** The QA hooks the page exposes (closures passed to the browser cannot see helpers, so the cast is inline every time). */
type Hooks = {
  __coastPost: () => {
    enabled: boolean;
    live: boolean;
    look: string;
    bloom?: number;
    contrast?: number;
    passes?: string[];
    lutSize?: number;
  };
  __coastLook: (name: string) => boolean;
  __coastPostLive: (on: boolean) => void;
  __coastShot: () => Promise<string>;
};

async function settle(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __coastReady?: boolean }).__coastReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => (window as unknown as { __coastLod?: boolean }).__coastLod === true, null, { timeout: 90_000 });
  const start = (await page.evaluate(() => (window as unknown as { __coastFrame?: number }).__coastFrame)) ?? 0;
  await page.waitForFunction((s) => ((window as unknown as { __coastFrame?: number }).__coastFrame ?? 0) >= s + 3, start, {
    timeout: 90_000,
  });
  await page.waitForFunction(() => ((window as unknown as { __coastDraws?: number }).__coastDraws ?? 0) >= 2, null, { timeout: 120_000 });
}

/** The picture off the canvas after the next rendered frame, reduced to mean chroma (max − min channel) and mean level. */
async function picture(page: Page, name: string): Promise<{ chroma: number; mean: number }> {
  const capture = () => page.evaluate(() => (window as unknown as { __coastShot: () => Promise<string> }).__coastShot(), null);
  let dataUrl = await capture();
  for (let i = 0; i < 6; i++) {
    const next = await capture();
    if (next === dataUrl) break;
    dataUrl = next;
  }
  writeFileSync(`tests/e2e/__screenshots__/${name}.png`, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('bad capture'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let chroma = 0;
    let mean = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      mean += (r + g + b) / 3;
      n++;
    }
    return { chroma: chroma / n, mean: mean / n };
  }, dataUrl);
}

test('the look is a LUT on the picture: noir drains the chroma, clean brings it back; night switches the bloom in', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&cam=director&t=0&shot=1&tier=desktop&look=neon-night&time=night');
  await settle(page);
  // Desktop budgets: the stack is live, wearing the look from the URL, with the bloom pass in because it is night.
  await page.waitForFunction(() => (window as unknown as Hooks).__coastPost().enabled, null, { timeout: 60_000 });
  const post = await page.evaluate(() => (window as unknown as Hooks).__coastPost());
  expect(post).toMatchObject({ enabled: true, live: true, look: 'neon-night', lutSize: 32 });
  expect(post.bloom!).toBeGreaterThan(0.5);
  expect(post.contrast!).toBeCloseTo(1.1, 2); // the night grade's share of the LUT
  expect(post.passes).toEqual(['RenderPass', 'EffectPass', 'EffectPass']); // scene, bloom, the grade pass
  const neon = await picture(page, 'post-neon-night');

  // Noir: the same frame with no chroma left (a monochrome LUT), darker corners (its vignette).
  expect(await page.evaluate(() => (window as unknown as Hooks).__coastLook('noir'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Hooks).__coastLook('sepia-1899'))).toBe(false);
  await page.waitForFunction(() => (window as unknown as Hooks).__coastPost().look === 'noir', null, { timeout: 10_000 });
  const noir = await picture(page, 'post-noir');
  expect(noir.chroma).toBeLessThan(1.5);
  expect(neon.chroma).toBeGreaterThan(noir.chroma + 8);
  const noirPost = await page.evaluate(() => (window as unknown as Hooks).__coastPost());
  expect(noirPost.bloom!).toBeLessThan(post.bloom!); // noir lets less of the neon bloom through
  expect(noirPost.passes).toEqual(['RenderPass', 'EffectPass', 'EffectPass']);

  // Clean: the picture as rendered — chroma back, and at noon the bloom pass drops out (nothing neon to bloom).
  await page.evaluate(() => (window as unknown as Hooks).__coastLook('clean'));
  const clean = await picture(page, 'post-clean-night');
  expect(clean.chroma).toBeGreaterThan(noir.chroma + 8);
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('`?post=0` renders straight to the canvas; the look is still remembered for the cut', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?scene=butterfly&cam=director&t=0&shot=1&tier=desktop&post=0&look=vhs-1994');
  await page.waitForFunction(() => (window as unknown as { __coastReady?: boolean }).__coastReady === true, null, { timeout: 90_000 });
  const post = await page.evaluate(() => (window as unknown as Hooks).__coastPost());
  expect(post).toEqual({ enabled: false, live: false, look: 'vhs-1994' });
  expect(await page.locator('#hud').innerText()).toContain('look vhs-1994 (export)');
});

test('a clean look at noon through the stack is the direct render, to the bit (ADR-0010)', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/?scene=butterfly&cam=director&t=0&shot=1&tier=desktop');
  await settle(page);
  await page.waitForFunction(() => (window as unknown as Hooks).__coastPost().enabled, null, { timeout: 60_000 });
  const stable = async () => {
    let d = await page.evaluate(() => (window as unknown as Hooks).__coastShot());
    for (let i = 0; i < 6; i++) {
      const n = await page.evaluate(() => (window as unknown as Hooks).__coastShot());
      if (n === d) break;
      d = n;
    }
    return d;
  };
  const through = await stable();
  await page.evaluate(() => (window as unknown as Hooks).__coastPostLive(false));
  await page.waitForFunction(() => !(window as unknown as Hooks).__coastPost().enabled, null, { timeout: 10_000 });
  const direct = await stable();
  expect(direct.length).toBeGreaterThan(1000);
  expect(through === direct, 'the post stack at clean/noon must not change a single pixel').toBe(true);
  await page.evaluate(() => (window as unknown as Hooks).__coastPostLive(true));
  await page.waitForFunction(() => (window as unknown as Hooks).__coastPost().enabled, null, { timeout: 10_000 });
  expect(await stable()).toBe(through);
});
