/**
 * World Labs Marble adapter (goal.md M2 / W-2 / CAP-2 / AF-1 / SCH-1).
 *
 * job (type "marble") → `POST /marble/v1/worlds:generate` → poll `/operations/{id}` (~5 min) → `GET /worlds/{id}` →
 * download spz 100k/500k/full + collider GLB + pano into tools/assets/out/cells/<cellId>/ → write cell.json (SCH-1) →
 * mirror into apps/web/public/cells/<cellId>/ (dev server) → log the spend in docs/costs.md + docs/cells.md.
 *
 * API per goal.md Appendix A (verified 2026-09-06): base https://api.worldlabs.ai, header `WLT-Api-Key`. Only fields
 * listed there are used — re-verify on first real call. Cost guardrails: job.budgetUsd, DAILY_SPEND_CAP_USD (docs/costs.md
 * log), a previous world for the same cell is REUSED unless `--force` (or `params.worldId`) says otherwise.
 */
import { openAsBlob } from 'node:fs';
import { access, copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { AlignView, Cell, TimePreset } from '../../../packages/engine/src/world/cell';
import { repoRoot, requireEnv } from '../lib/env';
import { HttpError, describeUrl, download, fetchJson, formatBytes, withRetry } from '../lib/http';
import { toolsAssetsDir, type AdapterOptions, type AssetJob } from '../lib/job';

// ── API shapes (only verified fields; see goal.md Appendix A) ──────────────────────────────────────────────────────

/** Override with WORLDLABS_API_BASE only to point at a local mock (tests); production is always the real host. */
const API_BASE = (process.env.WORLDLABS_API_BASE ?? 'https://api.worldlabs.ai').replace(/\/$/, '');
type MarbleModel = 'marble-1.1' | 'marble-1.1-plus';
/** USD per generated world (docs/costs.md reference prices). */
const UNIT_COST_USD: Record<MarbleModel, number> = { 'marble-1.1': 1.28, 'marble-1.1-plus': 2.48 };
const AZIMUTHS = [0, 90, 180, 270] as const;
type Azimuth = (typeof AZIMUTHS)[number];
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 20 * 60_000;
const TIME_PRESETS: TimePreset[] = ['golden', 'blue', 'night', 'fog_noon'];

type MediaRef = { source: 'uri'; uri: string } | { source: 'media_asset'; media_asset_id: string };
type WorldPrompt =
  | { type: 'text'; text_prompt: string }
  | { type: 'image'; image_prompt: MediaRef; text_prompt?: string }
  | { type: 'multi-image'; multi_image_prompt: { azimuth: Azimuth; content: MediaRef }[]; text_prompt?: string };

interface GenerateBody {
  display_name: string;
  model: MarbleModel;
  world_prompt: WorldPrompt;
}

interface Operation {
  operation_id: string;
  done: boolean;
  error?: unknown;
  metadata?: { progress?: { status?: string; description?: string }; world_id?: string };
  response?: unknown;
}

interface World {
  id: string;
  display_name?: string;
  world_marble_url?: string;
  assets?: {
    caption?: string;
    thumbnail_url?: string;
    splats?: {
      spz_urls?: Partial<Record<'100k' | '500k' | 'full_res', string>>;
      semantics_metadata?: { metric_scale_factor?: number; ground_plane_offset?: number };
    };
    mesh?: { collider_mesh_url?: string; hq_mesh_url?: string; full_res_mesh_url?: string };
    imagery?: { pano_url?: string };
  };
  model?: string;
  world_prompt?: unknown;
}

interface PrepareUpload {
  media_asset: { id: string };
  upload_info: { upload_url: string; upload_method?: string; required_headers?: Record<string, string> };
}

// ── Job spec ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface MarbleSpec {
  text: string | undefined;
  images: string[]; // repo-relative paths as written in the job
  model: MarbleModel;
  displayName: string;
  cellId: string;
  lighting: Cell['lighting'];
  worldIdOverride: string | undefined;
  unitCostUsd: number;
}

function parseSpec(job: AssetJob): MarbleSpec {
  if (job.type !== 'marble') throw new Error(`job ${job.id} has type "${job.type}", expected "marble"`);
  const params = (job.params ?? {}) as Record<string, unknown>;
  const text = job.inputs.text;
  if (text !== undefined && typeof text !== 'string') throw new Error(`${job.id}: inputs.text must be a string`);
  const images = job.inputs.images ?? [];
  if (!Array.isArray(images) || !images.every((p) => typeof p === 'string')) throw new Error(`${job.id}: inputs.images must be a string[]`);
  if (!text?.trim() && images.length === 0) throw new Error(`${job.id}: inputs.text or inputs.images is required`);
  if (images.length > AZIMUTHS.length) {
    throw new Error(`${job.id}: v0 supports at most ${AZIMUTHS.length} images (azimuths ${AZIMUTHS.join('/')}); got ${images.length}`);
  }
  const model = (params.model as string | undefined) ?? 'marble-1.1';
  if (!(model in UNIT_COST_USD)) throw new Error(`${job.id}: params.model must be one of ${Object.keys(UNIT_COST_USD).join(', ')}`);
  const cellId = (params.cellId as string | undefined) ?? job.id.replace(/^cell-/, '');
  if (!/^[a-z0-9-]+$/.test(cellId)) throw new Error(`${job.id}: cellId "${cellId}" must match [a-z0-9-]+`);
  const lightingIn = (params.lighting as { preset?: string; envmapFromPano?: boolean } | undefined) ?? {
    preset: 'golden',
    envmapFromPano: true,
  };
  const preset = lightingIn.preset ?? 'golden';
  if (!TIME_PRESETS.includes(preset as TimePreset))
    throw new Error(`${job.id}: params.lighting.preset must be one of ${TIME_PRESETS.join(', ')}`);
  const worldIdOverride = params.worldId as string | undefined;
  if (worldIdOverride !== undefined && typeof worldIdOverride !== 'string') throw new Error(`${job.id}: params.worldId must be a string`);
  return {
    text: text?.trim() || undefined,
    images: images as string[],
    model: model as MarbleModel,
    displayName: (params.displayName as string | undefined) ?? job.id,
    cellId,
    lighting: { preset: preset as TimePreset, envmapFromPano: lightingIn.envmapFromPano ?? true },
    worldIdOverride,
    unitCostUsd: UNIT_COST_USD[model as MarbleModel],
  };
}

function buildBody(spec: MarbleSpec, media: MediaRef[]): GenerateBody {
  let world_prompt: WorldPrompt;
  if (media.length === 0) {
    world_prompt = { type: 'text', text_prompt: spec.text! };
  } else if (media.length === 1) {
    world_prompt = { type: 'image', image_prompt: media[0]!, ...(spec.text ? { text_prompt: spec.text } : {}) };
  } else {
    world_prompt = {
      type: 'multi-image',
      multi_image_prompt: media.map((content, i) => ({ azimuth: AZIMUTHS[i]!, content })),
      ...(spec.text ? { text_prompt: spec.text } : {}),
    };
  }
  return { display_name: spec.displayName, model: spec.model, world_prompt };
}

// ── API client ─────────────────────────────────────────────────────────────────────────────────────────────────────

function marbleApi(apiKey: string) {
  const headers = { 'WLT-Api-Key': apiKey };
  return {
    get: <T>(path: string) => fetchJson<T>(`${API_BASE}${path}`, { headers }),
    post: <T>(path: string, body: unknown, opts?: { retries?: number; timeoutMs?: number }) =>
      fetchJson<T>(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }, opts),
  };
}
type MarbleApi = ReturnType<typeof marbleApi>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rel = (p: string) => relative(repoRoot, p) || '.';
const today = () => new Date().toISOString().slice(0, 10);
const log = (msg: string) => console.log(`[marble] ${msg}`);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function fileSize(path: string): Promise<number> {
  return stat(path).then(
    (s) => (s.isFile() ? s.size : -1),
    () => -1,
  );
}

async function uploadMediaAsset(api: MarbleApi, absPath: string): Promise<MediaRef> {
  const ext = extname(absPath).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw new Error(`unsupported image "${rel(absPath)}" (png/jpg/jpeg/webp)`);
  const prep = await api.post<PrepareUpload>('/marble/v1/media-assets:prepare_upload', {
    file_name: basename(absPath),
    kind: 'image',
    extension: ext,
  });
  const { upload_url, upload_method = 'PUT', required_headers = {} } = prep.upload_info;
  const blob = await openAsBlob(absPath);
  await withRetry(`upload ${basename(absPath)}`, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout after 180000 ms')), 180_000);
    try {
      // Signed storage URL: send exactly the headers Marble asked for (never the API key).
      const res = await fetch(upload_url, { method: upload_method, headers: required_headers, body: blob, signal: ac.signal });
      if (!res.ok) throw new HttpError(res.status, upload_url, await res.text().catch(() => ''), upload_method);
    } finally {
      clearTimeout(timer);
    }
  });
  log(`uploaded ${rel(absPath)} (${formatBytes(blob.size)}) → media asset ${prep.media_asset.id}`);
  return { source: 'media_asset', media_asset_id: prep.media_asset.id };
}

async function pollOperation(api: MarbleApi, operationId: string): Promise<Operation> {
  const started = Date.now();
  let lastStatus = '';
  for (;;) {
    const op = await api.get<Operation>(`/marble/v1/operations/${operationId}`);
    const p = op.metadata?.progress;
    const status = [p?.status, p?.description].filter(Boolean).join(' — ');
    if (status && status !== lastStatus) {
      log(`${Math.round((Date.now() - started) / 1000)} s  ${status}`);
      lastStatus = status;
    }
    if (op.done) {
      if (op.error) throw new Error(`generation failed: ${JSON.stringify(op.error)}`);
      return op;
    }
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new Error(
        `gave up after ${POLL_TIMEOUT_MS / 60_000} min waiting for operation ${operationId}` +
          ` (world ${op.metadata?.world_id ?? 'unknown'}). Re-run the job later: the pending operation is resumed, not re-generated.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────────────────────────────────────────

type AssetKey = keyof Pick<Cell['assets'], 'spz100k' | 'spz500k' | 'spzFull' | 'collider' | 'pano'>;
interface PlannedFile {
  key: AssetKey;
  name: string;
  url: string;
}

function imageExt(url: string): string {
  try {
    const ext = extname(new URL(url).pathname).slice(1).toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
  } catch {
    return 'jpg';
  }
}

function planFiles(cellId: string, world: World): PlannedFile[] {
  const a = world.assets ?? {};
  const spz = a.splats?.spz_urls ?? {};
  const candidates: { key: AssetKey; name: string; url: string | undefined; field: string }[] = [
    { key: 'spz100k', name: `${cellId}.100k.spz`, url: spz['100k'], field: 'assets.splats.spz_urls.100k' },
    { key: 'spz500k', name: `${cellId}.500k.spz`, url: spz['500k'], field: 'assets.splats.spz_urls.500k' },
    { key: 'spzFull', name: `${cellId}.full.spz`, url: spz.full_res, field: 'assets.splats.spz_urls.full_res' },
    { key: 'collider', name: `${cellId}.collider.glb`, url: a.mesh?.collider_mesh_url, field: 'assets.mesh.collider_mesh_url' },
    {
      key: 'pano',
      name: `${cellId}.pano.${a.imagery?.pano_url ? imageExt(a.imagery.pano_url) : 'jpg'}`,
      url: a.imagery?.pano_url,
      field: 'assets.imagery.pano_url',
    },
  ];
  const missing = candidates.filter((c) => !c.url).map((c) => c.field);
  if (missing.length)
    throw new Error(
      `world ${world.id} has no ${missing.join(', ')} — GET /marble/v1/worlds/${world.id} returned: ${JSON.stringify(world).slice(0, 600)}`,
    );
  return candidates.map(({ key, name, url }) => ({ key, name, url: url! }));
}

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/** Six views on a 6 m ring around the origin at eye height, all looking at [0,1,0] (PHY-5 alignment renders). */
export function defaultAlignViews(radius = 6, eyeHeight = 1.6): AlignView[] {
  return [0, 60, 120, 180, 240, 300].map((deg, i) => {
    const rad = (deg * Math.PI) / 180;
    return { id: `v${i + 1}`, pos: [round3(radius * Math.sin(rad)), eyeHeight, round3(radius * Math.cos(rad))], lookAt: [0, 1, 0] };
  });
}

async function readCellJson(path: string): Promise<Partial<Cell> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<Cell>;
  } catch {
    return undefined;
  }
}

function nextVersion(existing: Partial<Cell> | undefined, sameWorld: boolean): string {
  const date = today();
  if (existing?.version && sameWorld) return existing.version; // identical content → Takes stay valid (ACT-4)
  const m = existing?.version?.match(/^(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  const n = m && m[1] === date ? Number(m[2]) + 1 : 1;
  return `${date}.${n}`;
}

function buildCell(spec: MarbleSpec, job: AssetJob, world: World, files: PlannedFile[], version: string): Cell {
  const sem = world.assets?.splats?.semantics_metadata;
  const urlOf = (key: AssetKey) => `/cells/${spec.cellId}/${files.find((f) => f.key === key)!.name}`;
  return {
    id: spec.cellId,
    version,
    title: spec.displayName,
    source: { kind: 'marble', worldId: world.id, model: spec.model, promptRef: spec.images[0] ?? 'text' },
    assets: {
      spz100k: urlOf('spz100k'),
      spz500k: urlOf('spz500k'),
      spzFull: urlOf('spzFull'),
      collider: urlOf('collider'),
      pano: urlOf('pano'),
    },
    transform: { metricScale: sem?.metric_scale_factor ?? 1, groundOffset: sem?.ground_plane_offset ?? 0, rotationEuler: [180, 0, 0] },
    spawns: [{ id: 'default', pos: [0, 0, 0], yaw: 0 }],
    zones: [],
    transitions: [],
    lighting: spec.lighting,
    alignViews: defaultAlignViews(),
    extra: {
      marble: {
        worldId: world.id,
        worldMarbleUrl: world.world_marble_url,
        caption: world.assets?.caption,
        thumbnailUrl: world.assets?.thumbnail_url,
        job: job.id,
      },
    },
  };
}

/** Hard-link (same filesystem, no extra disk) or copy a downloaded asset into apps/web/public. */
async function mirror(src: string, dst: string): Promise<'skipped' | 'linked' | 'copied'> {
  const [a, b] = await Promise.all([stat(src), stat(dst).catch(() => undefined)]);
  // Same inode = already hard-linked to this exact file; a size match is only trusted for copies (cross-device fallback).
  if (b?.isFile() && ((a.dev === b.dev && a.ino === b.ino) || (b.nlink === 1 && a.size === b.size && b.mtimeMs >= a.mtimeMs))) {
    return 'skipped';
  }
  await mkdir(join(dst, '..'), { recursive: true });
  await rm(dst, { force: true });
  try {
    await link(src, dst);
    return 'linked';
  } catch {
    await copyFile(src, dst);
    return 'copied';
  }
}

// ── Ledgers (docs/costs.md, docs/cells.md) ─────────────────────────────────────────────────────────────────────────

const isBlankRow = (cells: string[]) => cells.every((c) => c === '');
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

interface MdTable {
  start: number; // header line index
  end: number; // exclusive
  cols: string[];
  rows: string[][];
}

/** Parses the first markdown table at/after line `from` (header + separator + rows). */
function parseTable(lines: string[], from: number): MdTable | undefined {
  let start = from;
  while (start < lines.length && !lines[start]!.trim().startsWith('|')) {
    if (start > from && lines[start]!.startsWith('#')) return undefined; // ran into the next section
    start++;
  }
  if (start + 1 >= lines.length) return undefined;
  let end = start + 2;
  while (end < lines.length && lines[end]!.trim().startsWith('|')) end++;
  return { start, end, cols: splitRow(lines[start]!), rows: lines.slice(start + 2, end).map(splitRow) };
}

/** Emits a table the way Prettier formats markdown (padded columns, `---` separators at column width). */
function formatTable(cols: string[], rows: string[][]): string[] {
  const widths = cols.map((c, i) => Math.max(3, c.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => `| ${widths.map((w, i) => (cells[i] ?? '').padEnd(w)).join(' | ')} |`;
  return [line(cols), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)];
}

const costsPath = join(repoRoot, 'docs', 'costs.md');
const cellsPath = join(repoRoot, 'docs', 'cells.md');
const COSTS_COLS = ['date', 'job', 'vendor', 'units', 'USD'];

async function readCostLog(): Promise<{ lines: string[]; table: MdTable | undefined }> {
  const lines = (await readFile(costsPath, 'utf8').catch(() => '# Costs ledger\n')).split('\n');
  const heading = lines.findIndex((l) => l.trim() === '## Log');
  return { lines, table: heading < 0 ? undefined : parseTable(lines, heading + 1) };
}

async function spentTodayUsd(): Promise<number> {
  const { table } = await readCostLog();
  let sum = 0;
  for (const cells of table?.rows ?? []) {
    if (cells[0] !== today()) continue;
    const usd = Number((cells[4] ?? '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(usd)) sum += usd;
  }
  return sum;
}

async function appendCostLog(jobId: string, model: MarbleModel, usd: number): Promise<void> {
  const row = [today(), jobId, 'worldlabs', `1 world (${model})`, `≈${usd.toFixed(2)}`];
  const { lines, table } = await readCostLog();
  if (!table) {
    lines.push('', '## Log', '', ...formatTable(COSTS_COLS, [row]), '');
  } else {
    const rows = [...table.rows.filter((r) => !isBlankRow(r)), row];
    lines.splice(table.start, table.end - table.start, ...formatTable(table.cols, rows));
  }
  await writeFile(costsPath, lines.join('\n'));
  log(`logged ≈$${usd.toFixed(2)} in docs/costs.md`);
}

async function updateCellsDoc(cellId: string, patch: Record<string, string>): Promise<void> {
  const lines = (await readFile(cellsPath, 'utf8').catch(() => '# Cells\n')).split('\n');
  // The cells table is the first table in the file (right under "# Cells").
  const table = parseTable(lines, 0) ?? {
    start: lines.length,
    end: lines.length,
    cols: ['cell', 'source', 'model', 'cost', 'splats (full)', 'collider tris', 'status', 'world id'],
    rows: [],
  };
  const { cols, rows } = table;
  const colIndex = (name: string) => cols.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  for (const col of Object.keys(patch)) if (colIndex(col) < 0) cols.push(col);
  let row = rows.find((r) => (r[0] ?? '').toLowerCase().split(/[\s(]/)[0] === cellId);
  if (!row) {
    row = [cellId];
    rows.push(row);
  }
  for (const r of rows) while (r.length < cols.length) r.push('');
  for (const [col, value] of Object.entries(patch)) row[colIndex(col)] = value;
  lines.splice(table.start, table.end - table.start, ...formatTable(cols, rows));
  await writeFile(cellsPath, lines.join('\n'));
  log(`updated docs/cells.md row "${cellId}"`);
}

/** JSON in the shape Prettier leaves it (objects expanded, short primitive arrays inline) so `cell.json` stays lint-clean. */
function toPrettyJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || ['number', 'string', 'boolean'].includes(typeof v))) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
      if (indent.length + inline.length < 120) return inline;
    }
    return `[\n${value.map((v) => `${indent}  ${toPrettyJson(v, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${toPrettyJson(v, `${indent}  `)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

// ── Entry point ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function run(job: AssetJob, opts: AdapterOptions): Promise<void> {
  const spec = parseSpec(job);
  const outDir = join(toolsAssetsDir, 'out', 'cells', spec.cellId);
  const publicDir = join(repoRoot, 'apps', 'web', 'public', 'cells', spec.cellId);
  const outCellPath = join(outDir, 'cell.json');
  const pendingPath = join(outDir, 'marble-operation.json');
  const worldMarkerPath = join(outDir, 'marble-world.txt');
  const imagePaths = spec.images.map((p) => resolve(repoRoot, p));
  for (const p of imagePaths) if (!(await exists(p))) throw new Error(`${job.id}: input image not found: ${rel(p)}`);

  if (opts.publish) {
    const have = await exists(outCellPath);
    log(
      `TODO(R2): publish is not implemented yet — ${have ? `outputs stay local in ${rel(outDir)} and ${rel(publicDir)}` : `nothing to publish; run \`pnpm assets run ${job.id}\` first`}.`,
    );
    log(`The R2 step will upload content-hashed keys and write assets/manifests/${job.id}.json (AGENTS.md §3).`);
    return;
  }

  const apiKey = requireEnv('WORLDLABS_API_KEY');

  // Cost guardrails: reuse a world we already paid for unless told otherwise.
  const existing = (await readCellJson(outCellPath)) ?? (await readCellJson(join(publicDir, 'cell.json')));
  const pendingText = await readFile(pendingPath, 'utf8').catch(() => undefined);
  let pending: { operationId: string; worldId?: string } | undefined;
  if (pendingText !== undefined) {
    try {
      pending = JSON.parse(pendingText) as { operationId: string; worldId?: string };
    } catch (err) {
      throw new Error(`corrupt ${rel(pendingPath)} — delete it (the world may still exist in the Marble dashboard) and re-run`, {
        cause: err,
      });
    }
    if (typeof pending?.operationId !== 'string') throw new Error(`${rel(pendingPath)} has no operationId — delete it and re-run`);
  }
  let worldId = spec.worldIdOverride ?? (opts.force ? undefined : existing?.source?.worldId);
  const spentToday = await spentTodayUsd();
  const dailyCap = Number(process.env.DAILY_SPEND_CAP_USD ?? 40);

  if (opts.dryRun) {
    const media: MediaRef[] = imagePaths.map((p) => ({
      source: 'media_asset',
      media_asset_id: `<id from media-assets:prepare_upload of ${rel(p)}>`,
    }));
    log(`dry run — would POST ${API_BASE}/marble/v1/worlds:generate (header WLT-Api-Key: <redacted>)`);
    console.log(JSON.stringify(buildBody(spec, media), null, 2));
    if (worldId)
      log(`NOTE: a previous world ${worldId} exists for cell "${spec.cellId}" — a real run would reuse it (pass --force to regenerate).`);
    else if (pending) log(`NOTE: pending operation ${pending.operationId} would be resumed instead of generating a new world.`);
    log(
      `estimated cost ≈$${spec.unitCostUsd.toFixed(2)} (${spec.model}); job budget $${(job.budgetUsd ?? 0).toFixed(2)}; spent today $${spentToday.toFixed(2)} of $${dailyCap} cap`,
    );
    log(
      `outputs → ${rel(outDir)}/{${spec.cellId}.100k.spz, ${spec.cellId}.500k.spz, ${spec.cellId}.full.spz, ${spec.cellId}.collider.glb, ${spec.cellId}.pano.jpg, cell.json} mirrored to ${rel(publicDir)}/`,
    );
    log('no API call made.');
    return;
  }

  const api = marbleApi(apiKey);
  await mkdir(outDir, { recursive: true });
  let generatedNow = false;

  if (worldId) {
    log(
      `reusing world ${worldId} (${spec.worldIdOverride ? 'params.worldId' : 'previous cell.json'}); pass --force to generate a new one (≈$${spec.unitCostUsd.toFixed(2)})`,
    );
  } else {
    let operationId: string;
    if (pending && !opts.force) {
      operationId = pending.operationId;
      log(`resuming pending operation ${operationId} from ${rel(pendingPath)}`);
    } else {
      if (spec.unitCostUsd > (job.budgetUsd ?? 0)) {
        throw new Error(
          `refusing to start: ${spec.model} costs ≈$${spec.unitCostUsd.toFixed(2)} but ${job.id}.budgetUsd is $${(job.budgetUsd ?? 0).toFixed(2)}`,
        );
      }
      if (spentToday + spec.unitCostUsd > dailyCap) {
        throw new Error(
          `refusing to start: $${spentToday.toFixed(2)} spent today + ≈$${spec.unitCostUsd.toFixed(2)} exceeds DAILY_SPEND_CAP_USD=$${dailyCap} (AGENTS.md §4)`,
        );
      }
      const media: MediaRef[] = [];
      for (const p of imagePaths) media.push(await uploadMediaAsset(api, p));
      const body = buildBody(spec, media);
      log(`generating "${spec.displayName}" with ${spec.model} (${body.world_prompt.type} prompt, ≈$${spec.unitCostUsd.toFixed(2)}) …`);
      let op: Operation;
      try {
        // No automatic retry: a lost response could mean a world was already started (double spend).
        op = await api.post<Operation>('/marble/v1/worlds:generate', body, { retries: 0, timeoutMs: 120_000 });
      } catch (err) {
        throw new Error('worlds:generate failed — check the Marble dashboard before re-running to avoid a double spend', { cause: err });
      }
      operationId = op.operation_id;
      await writeFile(
        pendingPath,
        JSON.stringify(
          { job: job.id, operationId, worldId: op.metadata?.world_id, startedAt: new Date().toISOString(), model: spec.model },
          null,
          2,
        ),
      );
      await appendCostLog(job.id, spec.model, spec.unitCostUsd); // spend happens at generate time, not download time
      generatedNow = true;
      log(
        `operation ${operationId} started${op.metadata?.world_id ? ` (world ${op.metadata.world_id})` : ''}; polling every ${POLL_INTERVAL_MS / 1000} s (~5 min)`,
      );
    }
    const done = await pollOperation(api, operationId);
    worldId = done.metadata?.world_id ?? pending?.worldId;
    if (!worldId) throw new Error(`operation ${operationId} finished without metadata.world_id: ${JSON.stringify(done).slice(0, 600)}`);
    log(`world ${worldId} ready`);
  }

  const { world } = await api.get<{ world: World }>(`/marble/v1/worlds/${worldId}`);
  if (!world?.id) throw new Error(`GET /marble/v1/worlds/${worldId} returned no world`);
  const files = planFiles(spec.cellId, world);

  // Files already on disk are skipped only when they came from this very world (marker written before the first download),
  // so a --force regeneration or a params.worldId switch can never leave stale binaries next to a new cell.json.
  const sameWorld = (await readFile(worldMarkerPath, 'utf8').catch(() => '')).trim() === world.id;
  if (!sameWorld) await writeFile(worldMarkerPath, `${world.id}\n`);
  for (const f of files) {
    const dest = join(outDir, f.name);
    const size = await fileSize(dest);
    if (sameWorld && size > 0) {
      log(`${f.name} exists (${formatBytes(size)}) — skipping`);
      continue;
    }
    const r = await download(f.url, dest, { label: f.name });
    log(`${f.name}  ${formatBytes(r.bytes)}  sha256 ${r.sha256.slice(0, 12)}…  ← ${describeUrl(f.url)}`);
  }

  const version = nextVersion(existing, existing?.source?.worldId === world.id);
  const cell = buildCell(spec, job, world, files, version);
  await writeFile(outCellPath, `${toPrettyJson(cell)}\n`);
  await rm(pendingPath, { force: true });
  log(
    `wrote ${rel(outCellPath)} (version ${version}, metricScale ${cell.transform.metricScale}, groundOffset ${cell.transform.groundOffset})`,
  );

  await mkdir(publicDir, { recursive: true });
  for (const f of files) log(`${await mirror(join(outDir, f.name), join(publicDir, f.name))} → ${rel(join(publicDir, f.name))}`);
  await copyFile(outCellPath, join(publicDir, 'cell.json'));
  log(`copied cell.json → ${rel(join(publicDir, 'cell.json'))} (tracked in git; binaries are git-ignored)`);

  await updateCellsDoc(spec.cellId, {
    source: spec.images.length ? 'key art + text' : 'text',
    model: spec.model,
    ...(generatedNow ? { cost: `≈$${spec.unitCostUsd.toFixed(2)}` } : {}),
    status: 'generated',
    'world id': `\`${world.id}\``,
  });

  log(
    `done — load it at /?cell=${spec.cellId} once the client supports cells; publish to R2 with \`pnpm assets publish ${job.id}\` (TODO).`,
  );
}
