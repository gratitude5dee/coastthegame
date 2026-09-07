import { test, expect } from '@playwright/test';

type Cells = NonNullable<Window['__coastCells']>;
/** Inside `page.evaluate` / `waitForFunction` only window globals exist — spell the hook out every time. */

/**
 * Cell streaming (goal.md W-3, ADR-0009) on the local test bed: three butterflies 16 m apart on 4 m roads
 * (`?level=run`). The neighbour streams in when the player comes within 4 m of the doorway, the player arrives by
 * standing in the neighbour's return doorway, and a third cell evicts the first — never more than two resident.
 * Content follows the cell (ADR-0011): the hub's kit (the Photographer + three extras, five props, the lowrider),
 * a guide and a prop in each of the other two; what a cell brought leaves with it, and comes back when it does.
 */
test('streaming: the next cell loads on approach, arrival moves the active cell, ≤ 2 cells stay resident', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?scene=butterfly&level=run&physics=1&cam=director&tier=desktop&tts=0&mute=1');
  await page.waitForFunction(() => (window as unknown as { __coastPhysics?: boolean }).__coastPhysics === true, null, { timeout: 90_000 });
  // The hub alone is resident; its road east already stands (gated at the far end until the neighbour has ground).
  await page.waitForFunction(() => window.__coastCells?.loaded.includes('butterfly'), null, { timeout: 30_000 });
  let c: Cells = (await page.evaluate(() => window.__coastCells))!;
  expect(c.active).toBe('butterfly');
  expect(c.resident).toEqual(['butterfly']);
  expect(c.corridors).toBe(1);
  expect(c.nearest).toMatchObject({ to: 'butterfly-2' });
  expect(c.nearest!.distance).toBeGreaterThan(4); // 5 m from the doorway at spawn: nothing streams yet
  // Step towards the doorway: the neighbour streams in and lands with its ground.
  expect(await page.evaluate(() => window.__coastTeleport!(2, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.resident.includes('butterfly-2'), null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__coastCells?.loaded.includes('butterfly-2'), null, { timeout: 60_000 });
  c = (await page.evaluate(() => window.__coastCells))!;
  expect(c.active).toBe('butterfly'); // not there yet
  expect(c.resident).toEqual(['butterfly', 'butterfly-2']);
  // The hub put its kit down; the neighbour brought Nova and a cone with its ground.
  expect(c.content.butterfly).toEqual({ props: 5, npcs: 4, vehicle: true });
  expect(c.content['butterfly-2']).toEqual({ props: 1, npcs: 1, vehicle: false });
  expect(c.props.sort()).toEqual(['ball_5', 'can_3', 'can_4', 'cone_2', 'crate_1', 'crate_2']);
  await page.waitForFunction(() => window.__coastNpcs?.count === 5, null, { timeout: 30_000 });
  // Walk the road: the character keeps its footing across the seam (nobody falls through the world).
  await page.evaluate(() => {
    const g = window.__coastGame as { rig: { yaw: number } };
    g.rig.yaw = -Math.PI / 2; // face +X (the road)
  });
  const feet = () => {
    const g = window.__coastGame as { character: { feet(v: unknown): { x: number; y: number } }; tmpV: unknown };
    const f = g.character.feet(g.tmpV);
    return { x: f.x, y: f.y };
  };
  const before = await page.evaluate(feet);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(feet);
  expect(after.x).toBeGreaterThan(before.x + 0.5);
  expect(after.y).toBeGreaterThan(-3);
  // Standing in the neighbour's return doorway = arrival: it becomes the active cell; the first one stays resident.
  expect(await page.evaluate(() => window.__coastTeleport!(10, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.active === 'butterfly-2', null, { timeout: 30_000 });
  c = (await page.evaluate(() => window.__coastCells))!;
  expect(c.resident.sort()).toEqual(['butterfly', 'butterfly-2']);
  expect(c.corridors).toBe(2); // both roads out of the active cell stand
  expect(c.gates).toBe(1); // only the far end of the road to the unloaded third cell is walled
  await expect(page.locator('#hud')).toContainText('run: 2 of 3', { timeout: 60_000 }); // the HUD redraws every 10 frames — seconds on software GL
  // Towards the third cell: it streams in and the first cell leaves — two resident, never three.
  expect(await page.evaluate(() => window.__coastTeleport!(19, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.resident.includes('butterfly-3'), null, { timeout: 30_000 });
  c = (await page.evaluate(() => window.__coastCells))!;
  expect(c.resident.sort()).toEqual(['butterfly-2', 'butterfly-3']);
  expect(c.corridors).toBe(2); // the road back stays (the active cell exits through it) — walled off at the far end
  expect(c.gates).toBeGreaterThanOrEqual(1);
  // The hub's people, props and car left with it; Nova stayed.
  expect(c.content.butterfly).toBeUndefined();
  expect(c.props.sort()).toEqual(['cone_2']);
  expect(await page.evaluate(() => window.__coastNpcs)).toMatchObject({ count: 1, photographer: null });
  expect(await page.evaluate(() => window.__coastVehicle)).toBeUndefined();
  await page.waitForFunction(() => window.__coastCells?.loaded.includes('butterfly-3'), null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__coastNpcs?.count === 2, null, { timeout: 30_000 }); // Kai, with the third cell's ground
  c = (await page.evaluate(() => window.__coastCells))!;
  expect(c.content['butterfly-3']).toEqual({ props: 1, npcs: 1, vehicle: false });
  expect(c.props.sort()).toEqual(['ball_3', 'cone_2']);
  expect(await page.evaluate(() => window.__coastTeleport!(26, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.active === 'butterfly-3', null, { timeout: 30_000 });
  // Back west (arrival = standing in the second cell's east doorway, x 21…23): the hub streams in again with its kit
  // (and its Photographer) once the player is within 4 m of the doorway towards it, and the far cell leaves.
  expect(await page.evaluate(() => window.__coastTeleport!(22, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.active === 'butterfly-2', null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__coastTeleport!(13, 0.4, 0))).toBe(true);
  await page.waitForFunction(() => window.__coastCells?.content.butterfly?.npcs === 4, null, { timeout: 90_000 });
  c = (await page.evaluate(() => window.__coastCells))!;
  expect(c.resident.sort()).toEqual(['butterfly', 'butterfly-2']);
  expect(c.content.butterfly).toEqual({ props: 5, npcs: 4, vehicle: true });
  expect(c.props.sort()).toEqual(['ball_5', 'can_3', 'can_4', 'cone_2', 'crate_1', 'crate_2']);
  expect(await page.evaluate(() => window.__coastNpcs?.count)).toBe(5);
  expect(errors, errors.join('\n')).toHaveLength(0);
});
