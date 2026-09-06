import { defineConfig } from '@playwright/test';

/**
 * Headless screenshot harness (AGENTS.md §2.4). SwiftShader gives deterministic *correctness* screenshots;
 * it is never evidence of performance (goal.md QB-1). Launch flags follow OpenAI's "building games with Astra" guide.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  snapshotPathTemplate: '{testDir}/__baselines__/{arg}{ext}',
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
    },
  },
  webServer: {
    command: 'pnpm --filter @coast/web preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
