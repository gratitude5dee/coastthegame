/**
 * Minimal `.env` loader for agent-time tools (no dependency). Secrets normally come from the environment
 * (AGENTS.md §1); a local `<repo>/.env` (git-ignored) is a convenience for desktop runs.
 * Never logs or returns secret values — only variable names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Repo root, derived from this file's location (tools/assets/lib → repo). */
export const repoRoot = resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..');

/** Parse `KEY=value` lines (`export KEY=value` allowed; `#` comments; single/double quotes; inline `# …` after unquoted values). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // unquoted: strip an inline comment (`VALUE   # note`)
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
      if (value.startsWith('#')) value = '';
    }
    out[key] = value;
  }
  return out;
}

export interface LoadEnvResult {
  path: string;
  found: boolean;
  loaded: string[]; // variable NAMES set from the file (never values)
  skipped: string[]; // names already present in process.env (left untouched)
}

/** Reads `<repo>/.env` (or `dir/.env`) into `process.env` without overriding variables that are already set. Empty values are ignored. */
export function loadEnv(dir: string = repoRoot): LoadEnvResult {
  const path = resolve(dir, '.env');
  const result: LoadEnvResult = { path, found: false, loaded: [], skipped: [] };
  if (!existsSync(path)) return result;
  result.found = true;
  const parsed = parseDotenv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (value === '') continue;
    if (process.env[key] !== undefined && process.env[key] !== '') {
      result.skipped.push(key);
      continue;
    }
    process.env[key] = value;
    result.loaded.push(key);
  }
  return result;
}

/** Returns the value of a required variable, or throws an error naming it (the value is never included). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Export it in your shell or set it in <repo>/.env (git-ignored; see .env.example).`,
    );
  }
  return value;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE)/i;

/** Replaces any secret-looking env value (names matching KEY/TOKEN/SECRET/…) found in `text` with `<redacted:NAME>`. Belt-and-braces for error output. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    if (out.includes(value)) out = out.split(value).join(`<redacted:${name}>`);
  }
  return out;
}
