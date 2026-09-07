import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

test('STU-2: a recorded take becomes a grounded control reference package', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/**', (route) => {
    requests.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: false } });
  });
  await page.goto('/?scene=butterfly&physics=1&lod=0&cam=director&mission=1&tier=desktop&mute=1&tts=0&look=clean');
  await page.waitForFunction(() => window.__coastPhysics === true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.mc-state')).toContainText('REC');
  const frame = await page.evaluate(() => window.__coastFrame ?? 0);
  await page.keyboard.down('KeyW');
  await page.waitForFunction((initial) => (window.__coastFrame ?? 0) >= initial + 5, frame);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Enter');
  await expect(page.locator('.mc-verdict')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Start (s)', { exact: true }).fill('0', { timeout: 30_000 });
  await page.getByLabel('End (s)', { exact: true }).fill('0.2', { timeout: 30_000 });
  await page.locator('[data-act=export-control]').click();
  const link = page.locator('[data-act=download-control]');
  await expect(link).toBeVisible({ timeout: 150_000 });
  const pendingDownload = page.waitForEvent('download');
  await link.click();
  const download = await pendingDownload;
  const archive = testInfo.outputPath('control-package.tar');
  await download.saveAs(archive);
  const names = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n');
  expect(names.slice(0, 3).map((name) => name.split('.')[0])).toEqual(['beauty', 'depth', 'pose']);
  expect(names.slice(0, 3).every((name) => /\.(mp4|webm)$/.test(name))).toBe(true);
  expect(names.slice(3)).toEqual(['hero.png', 'camera.json', 'prompts.json', 'prompts.txt', 'package.json']);
  const member = (name: string) => execFileSync('tar', ['-xOf', archive, name], { maxBuffer: 32 * 1024 * 1024 });
  const manifest = JSON.parse(member('package.json').toString()) as {
    files: { name: string; bytes: number; sha256: string }[];
    geometry: { width: number; height: number };
    timing: { startS: number; endS: number; fps: number; frames: number };
    hero: { timeS: number; frame: number };
    poseSources?: { unit: string; rig: number; procedural: number; omitted: number };
  };
  expect(manifest.timing).toMatchObject({ startS: 0, endS: 0.2, fps: 30, frames: 6 });
  expect(manifest.geometry).toEqual({ width: 1280, height: 720 });
  expect(manifest.hero).toMatchObject({ timeS: 0, frame: 0 });
  expect(manifest.poseSources).toMatchObject({ unit: 'actor-frame', procedural: 0, omitted: 0 });
  expect(manifest.poseSources!.rig).toBeGreaterThanOrEqual(6);
  for (const file of manifest.files) {
    const bytes = member(file.name);
    expect(bytes.length).toBe(file.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  const camera = JSON.parse(member('camera.json').toString());
  expect(camera.frames).toHaveLength(6);
  expect(camera.frames[0].t).toBe(0);
  const prompts = JSON.parse(member('prompts.json').toString());
  expect(prompts.context).toMatchObject({ cell: 'butterfly', cameraSource: 'take' });
  expect(prompts.subjects[0].avatar.id).toBe('mannequin');
  expect(Object.keys(prompts.variants).sort()).toEqual(['kling', 'ltx', 'seedance', 'veo', 'wan']);
  const hero = member('hero.png');
  expect(hero.subarray(1, 4).toString()).toBe('PNG');
  writeFileSync('tests/e2e/__screenshots__/control-package-hero.png', hero);
  const data = await page.evaluate(async () => {
    const result = await window.__coastExportControl!({ startS: 0, endS: 0.2, fps: 5, preview: true, passes: ['depth', 'pose'] });
    return { previews: result.preview, hero: result.hero, files: result.package.files };
  });
  expect(data.hero).toMatchObject({ width: 1280, height: 720, frame: 0 });
  expect(data.files.some((name) => name.startsWith('beauty.'))).toBe(false);
  for (const pass of ['depth', 'pose']) {
    const png = data.previews?.[pass];
    expect(png).toMatch(/^data:image\/png;base64,/);
    writeFileSync(
      `tests/e2e/__screenshots__/control-package-${pass}.png`,
      Buffer.from(png!.replace(/^data:image\/png;base64,/, ''), 'base64'),
    );
  }
  const current = await page.evaluate(() => window.__coastFrame ?? 0);
  await page.waitForFunction((initial) => (window.__coastFrame ?? 0) > initial + 1, current);
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  expect(errors).toEqual([]);
});
