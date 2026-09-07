import { test, expect } from './fixtures';
import { writeFileSync } from 'node:fs';

function figurineGlb(): Buffer {
  const positions = [0, 0, -0.2, -0.3, 0, 0.2, 0.3, 0, 0.2, 0, 1, 0];
  const indices = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
  const binary = Buffer.alloc(72);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  indices.forEach((value, index) => binary.writeUInt16LE(value, 48 + index * 2));
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.8, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.3, 0, -0.2], max: [0.3, 1, 0.2] },
        { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
      ],
    }),
  );
  const padded = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(12 + 8 + padded + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  glb.fill(0x20, 20, 20 + padded);
  json.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + padded);
  glb.writeUInt32LE(0x004e4942, 24 + padded);
  binary.copy(glb, 28 + padded);
  return glb;
}

test('CAP-1: mannequin, upload, URL, failure recovery, and input ownership', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const feet = () => {
    const game = window.__coastGame as { playerMesh: { position: { x: number; y: number; z: number } } };
    const p = game.playerMesh.position;
    return { x: p.x, y: p.y, z: p.z };
  };
  await page.route('**/api/avatar/capabilities', (route) =>
    route.fulfill({ json: { providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': false } } }),
  );
  await page.route('**/qa-figurine.glb', (route) => route.fulfill({ contentType: 'model/gltf-binary', body: figurineGlb() }));
  await page.goto('/?scene=butterfly&physics=1&lod=0&cam=director&tier=desktop&mute=1&tts=0');
  await page.waitForFunction(() => window.__coastPhysics === true);
  expect(await page.evaluate(() => window.__coastAvatar!().report)).toMatchObject({ rig: 'mixamo', boneCount: 22 });
  await page.keyboard.press('KeyU');
  const card = page.getByRole('dialog', { name: 'Your avatar' });
  await expect(card).toBeVisible();
  await expect(card.locator('[data-avatar=availability]')).toContainText('Upload and URL still work');
  await card.locator('[data-avatar=file]').setInputFiles({ name: 'My figurine.glb', mimeType: 'model/gltf-binary', buffer: figurineGlb() });
  await expect(card.locator('[data-avatar=status]')).toContainText('figurine (no supported rig)');
  const uploaded = await page.evaluate(() => window.__coastAvatar!());
  expect(uploaded).toMatchObject({ name: 'My figurine.glb', report: { rig: 'unrigged', triangles: 4, heightM: 1.8 } });
  await card.locator('[data-avatar=url]').fill(`${new URL(page.url()).origin}/qa-figurine.glb`);
  await card.getByRole('button', { name: 'Use URL', exact: true }).click();
  await expect(card.locator('[data-avatar=status]')).toContainText('qa-figurine.glb');
  const fromUrl = await page.evaluate(() => window.__coastAvatar!().id);
  expect(fromUrl).toBe(uploaded.id);
  await card
    .locator('[data-avatar=file]')
    .setInputFiles({ name: 'bad.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('invalid GLB') });
  await expect(card.locator('[data-avatar=status]')).not.toContainText('Inspecting');
  expect(await page.evaluate(() => window.__coastAvatar!().id)).toBe(fromUrl);
  await card.getByRole('button', { name: 'Use mannequin', exact: true }).click();
  await expect(card.locator('[data-avatar=status]')).toContainText('Mannequin');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__coastAvatar!().id)).toBe('mannequin');
  const start = await page.evaluate(feet);
  const before = await page.evaluate(() => window.__coastFrame ?? 0);
  await page.keyboard.down('KeyW');
  await page.waitForFunction((frame) => (window.__coastFrame ?? 0) > frame + 4, before);
  await page.keyboard.up('KeyW');
  const end = await page.evaluate(feet);
  expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(0.05);
  const png = await page.evaluate(() => window.__coastShot!());
  writeFileSync(testInfo.outputPath('avatar-desktop.png'), Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
  expect(errors).toEqual([]);
});

test('CAP-1: device-saved avatar and take survive reload without refetch, and removal is explicit', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const modelRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\.glb(?:\?|$)/.test(request.url())) modelRequests.push(request.url());
  });
  await page.route('**/api/**', (route) =>
    route.fulfill({ json: { ok: false, providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': false } } }),
  );
  await page.goto('/?scene=butterfly&physics=1&lod=0&cam=director&mission=1&tier=desktop&mute=1&tts=0');
  await page.waitForFunction(() => window.__coastPhysics === true);
  await page.keyboard.press('KeyU');
  const card = page.getByRole('dialog', { name: 'Your avatar' });
  await expect(card).toBeVisible();
  await card.getByLabel('Save on this device', { exact: true }).check();
  await card
    .locator('[data-avatar=file]')
    .setInputFiles({ name: 'Saved performer.glb', mimeType: 'model/gltf-binary', buffer: figurineGlb() });
  await expect(card.locator('[data-avatar=status]')).toContainText('Saved on this device');
  const id = await page.evaluate(() => window.__coastAvatar!().id);
  expect(id).toMatch(/^avatar-[0-9a-f]{64}$/);
  await expect(card.locator('[data-avatar=library-status]')).toContainText('1 saved avatars');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Enter');
  await expect(page.locator('.mc-state')).toContainText('REC');
  const frame = await page.evaluate(() => window.__coastFrame ?? 0);
  await page.waitForFunction((initial) => (window.__coastFrame ?? 0) >= initial + 5, frame);
  await page.keyboard.press('Enter');
  await expect(page.locator('.mc-verdict')).toBeVisible({ timeout: 30_000 });
  const takeId = await page.evaluate(() => (window.__coastGame as { studio: { lastTake: { id: string } } }).studio.lastTake.id);
  await page.waitForFunction(
    (savedId) =>
      new Promise<boolean>((resolve, reject) => {
        const open = indexedDB.open('coast');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('takes').objectStore('takes').get(savedId);
          request.onsuccess = () => {
            db.close();
            resolve(!!request.result);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        };
      }),
    takeId,
  );
  await page.reload();
  await page.waitForFunction((savedId) => window.__coastPhysics && window.__coastAvatar?.().id === savedId, id);
  await page.keyboard.press('KeyU');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-avatar=status]')).toContainText('Saved performer.glb');
  await card.getByRole('button', { name: 'Use mannequin', exact: true }).click();
  await expect(card.locator('[data-avatar=status]')).toContainText('Mannequin');
  await page.reload();
  await page.waitForFunction(() => window.__coastPhysics === true);
  expect(await page.evaluate(() => window.__coastAvatar!().id)).toBe('mannequin');
  await page.locator('#coast-reel button[data-mission="m01-low-and-slow"]').click();
  await page
    .waitForFunction(() => (window.__coastGame as { studio: { reviewing: string | null } }).studio.reviewing === 'm01-low-and-slow', null, {
      timeout: 30_000,
    })
    .catch(async (error: unknown) => {
      const state = await page.evaluate(() => {
        const game = window.__coastGame as {
          studio: { reviewing: string | null; state: string; exporting: boolean };
          avatarLoads: Map<string, unknown>;
          avatars: Map<string, unknown>;
        };
        return {
          reviewing: game.studio.reviewing,
          state: game.studio.state,
          exporting: game.studio.exporting,
          loading: [...game.avatarLoads.keys()],
          loaded: [...game.avatars.keys()],
          message: document.getElementById('coast-sub')?.textContent,
          card: document.querySelector<HTMLElement>('.coast-avatar')?.hidden,
        };
      });
      throw new Error(`Saved replay did not start: ${JSON.stringify(state)}`, { cause: error });
    });
  expect(
    await page.evaluate(() => {
      const studio = (window.__coastGame as { studio: { review: { ghosts: { boneWorldPositions(): unknown; look: { name: string } }[] } } })
        .studio;
      const ghost = studio.review.ghosts[0]!;
      return { name: ghost.look.name, joints: ghost.boneWorldPositions() };
    }),
  ).toEqual({ name: 'Saved performer.glb', joints: null });
  expect(modelRequests).toEqual([]);
  await page.keyboard.press('KeyU');
  await card.locator('[data-avatar=saved]').selectOption(id);
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: 'Remove saved', exact: true }).click();
  await expect
    .poll(
      async () => ({
        library: await card.locator('[data-avatar=library-status]').textContent(),
        status: await card.locator('[data-avatar=status]').textContent(),
      }),
      { timeout: 30_000 },
    )
    .toMatchObject({ library: expect.stringContaining('No saved avatars'), status: expect.stringContaining('Removed saved avatar') });
  await page.reload();
  await page.waitForFunction(() => window.__coastPhysics === true);
  await page.locator('#coast-reel button[data-mission="m01-low-and-slow"]').click();
  await expect(page.locator('#coast-sub')).toContainText('not saved on this device');
  expect(errors).toEqual([]);
});
