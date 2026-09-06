import { test as base, type Page } from '@playwright/test';

/**
 * A fresh browser per test. The slice tests record clips with MediaRecorder + canvas.captureStream; under SwiftShader
 * the capture path only works reliably in a browser process that has not already rendered other pages (the software
 * encoder dies at start after earlier captures), so each of these tests launches and closes its own Chromium.
 * Launch options / viewport / baseURL come from the active project so config overrides still apply.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ playwright }, use, testInfo) => {
    const u = testInfo.project.use;
    const browser = await playwright.chromium.launch(u.launchOptions);
    const context = await browser.newContext({ viewport: u.viewport ?? undefined, baseURL: u.baseURL });
    const page = await context.newPage();
    await use(page);
    await context.close();
    await browser.close();
  },
});
export { expect } from '@playwright/test';
