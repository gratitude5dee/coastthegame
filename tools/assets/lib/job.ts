/**
 * Asset job specs (goal.md AF-1; JSON schema in tools/assets/jobs/schema.json) and the adapter contract.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type JobType = 'concept' | 'texture' | 'tripo' | 'marble' | 'blender' | 'convert' | 'lod' | 'audio' | 'video';
export type OutputKind = 'png' | 'jpg' | 'glb' | 'spz' | 'rad' | 'json' | 'mp4' | 'opus' | 'wav';

export interface AssetJob {
  id: string;
  type: JobType;
  description?: string;
  inputs: Record<string, unknown>;
  params?: Record<string, unknown>;
  outputs: { name: string; kind: OutputKind }[];
  budgetUsd?: number;
  parallelSafe?: boolean;
}

export interface AdapterOptions {
  publish: boolean; // R2 publish step (AGENTS.md §3) — not implemented yet
  dryRun?: boolean; // print what would be sent to the vendor and exit without spending
  force?: boolean; // regenerate even when a previous run's output exists
}

export interface Adapter {
  run(job: AssetJob, opts: AdapterOptions): Promise<void>;
}

export const toolsAssetsDir = resolve(import.meta.dirname ?? process.cwd(), '..');
export const jobsDir = join(toolsAssetsDir, 'jobs');

export function listJobs(): AssetJob[] {
  return readdirSync(jobsDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort()
    .map((f) => readJobFile(join(jobsDir, f)));
}

export function readJob(id: string): AssetJob {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid job id "${id}" (expected [a-z0-9-]+)`);
  const path = join(jobsDir, `${id}.json`);
  let job: AssetJob;
  try {
    job = readJobFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no job spec at tools/assets/jobs/${id}.json (try: pnpm assets list)`, { cause: err });
    }
    throw err;
  }
  if (job.id !== id) throw new Error(`job id "${job.id}" in ${path} does not match the file name`);
  return job;
}

function readJobFile(path: string): AssetJob {
  const job = JSON.parse(readFileSync(path, 'utf8')) as Partial<AssetJob>;
  if (typeof job.id !== 'string' || typeof job.type !== 'string') throw new Error(`${path}: "id" and "type" are required`);
  if (typeof job.inputs !== 'object' || job.inputs === null) throw new Error(`${path}: "inputs" object is required`);
  if (!Array.isArray(job.outputs)) throw new Error(`${path}: "outputs" array is required`);
  return job as AssetJob;
}
