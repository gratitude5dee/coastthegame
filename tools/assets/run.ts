#!/usr/bin/env tsx
/**
 * Asset job runner (goal.md AF-1). Usage: pnpm assets run <job-id> | pnpm assets publish <job-id> | pnpm assets list
 * Each job type maps to an adapter in tools/assets/adapters/<type>.ts (to be written in M1–M2; MockProvider first).
 * Outputs are content-hashed, uploaded to R2 by the `publish` step, and registered in assets/manifests/<job>.json.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const jobsDir = join(import.meta.dirname ?? '.', 'jobs');
const [cmd, id] = process.argv.slice(2);

if (cmd === 'list') {
  for (const f of readdirSync(jobsDir).filter((f) => f.endsWith('.json') && f !== 'schema.json')) {
    const j = JSON.parse(readFileSync(join(jobsDir, f), 'utf8'));
    console.log(`${j.id.padEnd(24)} ${j.type.padEnd(8)} ~$${j.budgetUsd ?? 0}  ${j.description ?? ''}`);
  }
} else if (cmd === 'run' || cmd === 'publish') {
  if (!id) throw new Error('job id required');
  const job = JSON.parse(readFileSync(join(jobsDir, `${id}.json`), 'utf8'));
  console.log(`[assets] ${cmd} ${job.id} (${job.type}) — adapters land in M1/M2; see AGENTS.md §3`);
  // TODO(M1): import(`./adapters/${job.type}.ts`).then(m => m.run(job, { publish: cmd === 'publish' }))
} else {
  console.log('usage: pnpm assets <list|run|publish> [job-id]');
}
