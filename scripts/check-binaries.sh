#!/usr/bin/env bash
# Fails if any tracked (or staged) file exceeds 5 MB — AGENTS.md §3 / goal.md §10.6. Large assets live in R2.
set -euo pipefail
LIMIT=$((5 * 1024 * 1024))
bad=0
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  if (( size > LIMIT )); then echo "TOO LARGE (>5 MB): $f ($size bytes) — publish to R2 via 'pnpm assets publish' instead"; bad=1; fi
done < <(git ls-files; git diff --cached --name-only)
exit $bad
