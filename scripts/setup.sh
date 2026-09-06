#!/usr/bin/env bash
# Codex cloud environment setup (AGENTS.md §1, goal.md M0). Idempotent; target ≤10 min.
# Installs: Node 22 + pnpm, Rust (for Spark build-lod), Blender 5.2 LTS headless (or the bpy wheel), ffmpeg,
# gltf-transform CLI, KTX-Software (toktx), Playwright chromium. Skips anything already present.
set -euo pipefail

log() { printf '\n\033[1;33m[setup]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; if [[ "$(id -u)" != "0" ]] && have sudo; then SUDO="sudo"; fi

log "Node / pnpm"
if ! have node || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs
fi
have pnpm || npm i -g pnpm@9
pnpm install --frozen-lockfile   # never fall back to a lockfile-mutating install in CI/sandboxes

log "System packages (ffmpeg, build tools, GL libs for headless Blender)"
if have apt-get; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ffmpeg build-essential cmake pkg-config xz-utils libgl1 libxi6 libxrender1 libxkbcommon0 libsm6 libxext6 >/dev/null
fi

log "Spark build-lod (offline LoD → .rad, goal.md W-1/AF-5): prebuilt binary first, compile as fallback"
if ! have build-lod && [[ -n "${BUILD_LOD_URL:-}" ]]; then
  curl -fsSL "$BUILD_LOD_URL" -o /tmp/build-lod && chmod +x /tmp/build-lod && $SUDO install -m 755 /tmp/build-lod /usr/local/bin/build-lod || true
fi
if ! have build-lod && ! have cargo; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
if ! have build-lod; then
  log "compiling build-lod (can take 5+ min — publish a prebuilt binary and set BUILD_LOD_URL to skip this)"
  tmp=$(mktemp -d)
  git clone --depth 1 https://github.com/sparkjsdev/spark "$tmp/spark"
  (cd "$tmp/spark/rust/build-lod" && cargo build --release)   # per docs/docs/lod-getting-started.md
  bin=$(find "$tmp/spark/rust" -type f -name build-lod -path '*release*' | head -1 || true)
  [[ -n "$bin" ]] && $SUDO install -m 755 "$bin" /usr/local/bin/build-lod || log "build-lod not found — check rust/ layout in the Spark repo"
fi

log "Blender 5.2 LTS headless (bpy wheel if the Python minor matches, else the official tarball)"
if ! python3 -c "import bpy" >/dev/null 2>&1 && ! have blender; then
  # The bpy wheel only exists for the Python minor Blender was built with (bpy 4.x → 3.11, bpy 5.x → 3.13).
  # `pip download` checks compatibility without installing anything.
  if pip download --quiet --no-deps --dest /tmp/bpy-check bpy >/dev/null 2>&1 && pip install --quiet /tmp/bpy-check/bpy-*.whl; then
    log "bpy wheel installed for $(python3 --version)"
  else
    BL_URL="https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz"
    curl -fsSL "$BL_URL" -o /tmp/blender.tar.xz && $SUDO mkdir -p /opt/blender && $SUDO tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1
    $SUDO ln -sf /opt/blender/blender /usr/local/bin/blender
  fi
fi

log "glTF tooling (gltf-transform needs KTX-Software's toktx for KTX2 — there is NO built-in encoder)"
have gltf-transform || npm i -g @gltf-transform/cli
if ! have toktx; then
  # Resolve the current Linux x86_64 .deb asset name from the GitHub release API (names change per version).
  KTX_URL=$(curl -fsSL https://api.github.com/repos/KhronosGroup/KTX-Software/releases/latest | grep -o 'https://[^"]*Linux-x86_64[^"]*\.deb' | head -1 || true)
  if [[ -n "$KTX_URL" ]] && curl -fsSL "$KTX_URL" -o /tmp/ktx.deb && $SUDO dpkg -i /tmp/ktx.deb >/dev/null 2>&1; then
    log "toktx installed"
  else
    log "WARNING: toktx not installed — KTX2 texture compression is DISABLED until it is (gltf-transform will error on ktx2 steps)"
  fi
fi

log "Playwright chromium (SwiftShader screenshots)"
pnpm exec playwright install --with-deps chromium >/dev/null 2>&1 || pnpm exec playwright install chromium

log "Done. Verify: node -v; pnpm -v; cargo -V; blender -v || python3 -c 'import bpy'; ffmpeg -version | head -1; gltf-transform --version"
