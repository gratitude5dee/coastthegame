/**
 * PWA registration (goal.md UX-2, QB-11). The worker itself is `public/sw.js` (plain JS, served as `/sw.js`).
 *
 * Production only: in `vite dev`/`preview` a stale shell cache would mask code changes and the screenshot harness
 * must always render the fresh bundle. Registration waits for `load` so the install never competes with the first
 * splat download (QB-3). Every failure is swallowed — the app works exactly the same without a service worker.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    try {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
        console.warn('[pwa] service worker registration failed', err);
      });
    } catch (err) {
      console.warn('[pwa] service worker registration failed', err);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
