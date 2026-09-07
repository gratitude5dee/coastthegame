# ADR-0005 — Guest sessions, the budget ledger in a Durable Object, share tokens

**Status:** accepted (2026-09-06) · **Owner:** GRATITUD3 · **Refs:** goal.md BE-1, BE-2, BE-4, ACT-4, STU-3, ID-\*, AF-7

## Context

BE-1 lists `/auth/*`, `/realtime/secret`, `/cuts/*`, `/perf/report` and `/budget` on a Hono Worker. Identity (ID-\*, ADR-0004) lands in M8 and is still _proposed_ pending D-5/D-6, but the slice needs takes, cuts and the ledger now, and the Realtime secret must be gated by a budget from the very first live session (QB-10). Cuts are shared by link; the link must not leak whatever keys the session.

## Decision

- **Guest sessions.** The client mints a session id (`crypto.randomUUID()`, kept in `localStorage` under `coast:session`) and sends it as `x-coast-session` on every API call. The Worker accepts 8–64 chars of `[A-Za-z0-9_-]` and refuses everything else with 401. Only `/api/health`, cut playback, `/c/<token>` and `/perf` are public. Sign-in (M8) binds the same id to a user, so what was made as a guest survives the sign-in.
- **The ledger lives in `SessionDO`** (one Durable Object per session): `{ spentUsd, capUsd, calls[] }`, debits are storage transactions, 402 past the cap (3 USD per session in dev). `POST /api/realtime/secret` reserves five minutes at list price (0.4 USD mini, 1.6 USD premium) _before_ minting the ephemeral secret, so a session never starts a call it cannot afford; the minute-by-minute debit (DIR-6) settles against the reserve.
- **Takes** go to `takes/<session>/<id>.bin` in `coast-user` (the take codec's magic is checked, 4 MB cap, listed per session); **cuts** to `cuts/<session>/<id>.<ext>` (64 MB cap, video types only). A cut is public **by a random 16-char share token** indexed at `shares/<token>.json` — never by the session id; re-uploading a cut keeps its token. `/c/<token>` is a server-rendered page with byte-range playback.
- One origin: the Worker serves the built app (static assets, BE-4) and the API; Vite proxies `/api`, `/c/`, `/perf` to `wrangler dev` locally. `tests/api/worker.test.ts` runs the real Worker on workerd with emulated R2 and DOs.

## Consequences

- - No auth dependency for the slice; every guest's data is keyed, capped and rate-limited by session; the ledger gates vendor spend from day one.
- - Share links are unguessable and revocable independently of the session.
- − The session id is bearer-style: whoever holds it reads that session's takes. Mitigated by its entropy and by never putting it in a URL; fixed by OAuth binding in M8.
- − Presigned multipart upload (STU-3) is replaced by a direct `PUT` through the Worker with a 64 MB cap — enough for 60 s at 1080p; 4K cuts (desktop optional) need the presigned path.
