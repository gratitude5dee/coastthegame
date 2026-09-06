#!/usr/bin/env tsx
/**
 * Asset job runner (goal.md AF-1).
 *   pnpm assets list
 *   pnpm assets run <job-id> [--dry-run] [--force]
 *   pnpm assets publish <job-id>
 * Each job type maps to an adapter in tools/assets/adapters/<type>.ts exporting `run(job, opts)` (lib/job.ts `Adapter`).
 * Outputs land in tools/assets/out/<…> (git-ignored); the `publish` step (R2 + assets/manifests/<job>.json) is TODO.
 */
import { loadEnv, redactSecrets } from './lib/env';
import { errorMessage } from './lib/http';
import { listJobs, readJob, type Adapter } from './lib/job';

const USAGE = 'usage: pnpm assets list | run <job-id> [--dry-run] [--force] | publish <job-id>';

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.found)
    console.log(
      `[assets] loaded ${env.loaded.length} var(s) from .env${env.skipped.length ? ` (${env.skipped.length} already set in the environment)` : ''}`,
    );

  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [cmd, id] = args.filter((a) => !a.startsWith('--'));
  for (const f of flags) if (!['--dry-run', '--force'].includes(f)) throw new Error(`unknown flag ${f}\n${USAGE}`);

  if (cmd === 'list') {
    for (const j of listJobs()) {
      console.log(`${j.id.padEnd(24)} ${j.type.padEnd(8)} ~$${(j.budgetUsd ?? 0).toFixed(2).padStart(5)}  ${j.description ?? ''}`);
    }
    return;
  }

  if (cmd === 'run' || cmd === 'publish') {
    if (!id) throw new Error(`job id required\n${USAGE}`);
    const job = readJob(id);
    const opts = { publish: cmd === 'publish', dryRun: flags.has('--dry-run'), force: flags.has('--force') };
    console.log(`[assets] ${cmd} ${job.id} (${job.type})${opts.dryRun ? ' — dry run' : ''}`);
    let adapter: Adapter;
    try {
      adapter = (await import(`./adapters/${job.type}.ts`)) as Adapter;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        throw new Error(`no adapter for job type "${job.type}" yet (expected tools/assets/adapters/${job.type}.ts — see AGENTS.md §3)`, {
          cause: err,
        });
      }
      throw err;
    }
    if (typeof adapter.run !== 'function') throw new Error(`adapters/${job.type}.ts does not export run(job, opts)`);
    await adapter.run(job, opts);
    return;
  }

  throw new Error(USAGE);
}

main().catch((err: unknown) => {
  const msg = redactSecrets(errorMessage(err));
  console.error(`\n[assets] error: ${msg}`);
  if (process.env.ASSETS_DEBUG && err instanceof Error && err.stack) console.error(redactSecrets(err.stack));
  process.exitCode = 1;
});
