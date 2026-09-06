import type { Tier } from './tiers';

/**
 * Per-tier budgets (goal.md QB-1/QB-2, PLT-1). Source of truth for every number the runtime tunes by platform.
 * Spark defaults for lodSplatCount are 500K Oculus / 750K Vision Pro / 1M Android / 1.5M iOS / 2.5M desktop;
 * we start slightly conservative on Quest and iPhone and raise only with /perf evidence.
 */
export interface Budgets {
  targetFps: number;
  frameBudgetMs: number;
  lodSplatCount: number;
  maxStdDev: number; // Spark: sqrt(5) recommended for VR
  lodRenderScale: number; // Spark: >1 skips tinier screen-space splats (cheap win on mobile/VR)
  maxPixelRatio: number;
  xrFramebufferScale: number; // Spark default is 0.5 — we raise deliberately
  postProcessing: 'full' | 'grade' | 'none';
  physicsHz: number; // simulation is ALWAYS fixed-step (goal.md STU-1); export never re-simulates
  maxNpcs: number;
  residentCells: number; // active cell + nearest neighbour on every tier (goal.md W-3)
  dreamMode: boolean; // Lucy live restyle allowed
}

export const BUDGETS: Record<Tier, Budgets> = {
  desktop: {
    targetFps: 60,
    frameBudgetMs: 16.6,
    lodSplatCount: 2_500_000,
    maxStdDev: Math.sqrt(8),
    lodRenderScale: 1,
    maxPixelRatio: 2,
    xrFramebufferScale: 1,
    postProcessing: 'full',
    physicsHz: 60,
    maxNpcs: 8,
    residentCells: 2,
    dreamMode: true,
  },
  quest: {
    targetFps: 72,
    frameBudgetMs: 13.7,
    lodSplatCount: 750_000, // QB-2: raise to 1M / framebuffer 0.8 only with /perf evidence
    maxStdDev: Math.sqrt(5),
    lodRenderScale: 1.5,
    maxPixelRatio: 1,
    xrFramebufferScale: 0.7,
    postProcessing: 'grade',
    physicsHz: 36,
    maxNpcs: 4,
    residentCells: 2,
    dreamMode: false,
  },
  iphone: {
    targetFps: 60,
    frameBudgetMs: 16.6,
    lodSplatCount: 750_000,
    maxStdDev: Math.sqrt(5),
    lodRenderScale: 1.5,
    maxPixelRatio: 1.5,
    xrFramebufferScale: 1,
    postProcessing: 'grade',
    physicsHz: 60,
    maxNpcs: 5,
    residentCells: 2,
    dreamMode: false,
  },
  visionpro: {
    targetFps: 90,
    frameBudgetMs: 11.1,
    lodSplatCount: 750_000,
    maxStdDev: Math.sqrt(5),
    lodRenderScale: 1.5,
    maxPixelRatio: 1,
    xrFramebufferScale: 0.8,
    postProcessing: 'grade',
    physicsHz: 36,
    maxNpcs: 4,
    residentCells: 2,
    dreamMode: false,
  },
  android: {
    targetFps: 60,
    frameBudgetMs: 16.6,
    lodSplatCount: 750_000,
    maxStdDev: Math.sqrt(5),
    lodRenderScale: 1.5,
    maxPixelRatio: 1.5,
    xrFramebufferScale: 0.8,
    postProcessing: 'grade',
    physicsHz: 60,
    maxNpcs: 5,
    residentCells: 2,
    dreamMode: false,
  },
  fallback: {
    targetFps: 30,
    frameBudgetMs: 33.3,
    lodSplatCount: 500_000,
    maxStdDev: Math.sqrt(5),
    lodRenderScale: 2,
    maxPixelRatio: 1,
    xrFramebufferScale: 1,
    postProcessing: 'none',
    physicsHz: 60,
    maxNpcs: 3,
    residentCells: 2,
    dreamMode: false,
  },
};

export function budgetsFor(tier: Tier): Budgets {
  return BUDGETS[tier];
}
