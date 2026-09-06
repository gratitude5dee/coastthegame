#!/usr/bin/env bash
# Build a streaming LoD tree (.rad + .radc chunks) from .spz/.ply (goal.md W-1, AF-5).
# Usage: scripts/build-lod.sh in.spz [out-dir]   → writes <stem>-lod.rad and <stem>-lod-N.radc next to the input (or in out-dir)
# Options passed to Spark's build-lod: --quality (bhatt-lod, recommended offline), --rad-chunked (streaming), --max-sh=# (0..3)
set -euo pipefail
in="$1"; out="${2:-$(dirname "$in")}"; mkdir -p "$out"
cp -n "$in" "$out/" 2>/dev/null || true
( cd "$out" && build-lod "$(basename "$in")" --quality --rad-chunked --max-sh=1 )
ls -la "$out"
echo "Load with: new SplatMesh({ url: '<R2>/$(basename "${in%.*}")-lod.rad', paged: true })  (R2 must serve Range requests)"
