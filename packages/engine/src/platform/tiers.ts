/**
 * Platform tier detection (goal.md PLT-1).
 * Every subsystem reads numbers from budgets.ts keyed by the tier — never hard-code.
 */
export type Tier = 'desktop' | 'quest' | 'iphone' | 'visionpro' | 'android' | 'fallback';
export const TIERS: Record<Tier, true> = { desktop: true, quest: true, iphone: true, visionpro: true, android: true, fallback: true };

export interface PlatformInfo {
  tier: Tier;
  ua: string;
  webgl2: boolean;
  webxr: boolean; // navigator.xr present (never true on iPhone Safari as of iOS 26)
  webgpu: boolean; // informational only in v1 (A3)
  touch: boolean;
  dpr: number;
  memoryGB?: number;
}

/** Detects a software GL implementation (SwiftShader/llvmpipe/Mesa software) — PLT-3 → 'fallback'. */
export function isSoftwareRenderer(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return /SwiftShader|llvmpipe|Software|Basic Render/i.test(r);
  } catch {
    return false;
  }
}

export function detectPlatform(nav: Navigator = navigator, win: Window = window): PlatformInfo {
  const ua = nav.userAgent || '';
  // Test/QA override: /?tier=quest forces budgets (screenshot harness runs on SwiftShader but must use desktop budgets).
  const override = new URLSearchParams(win.location?.search ?? '').get('tier') as Tier | null;
  const touch = 'ontouchstart' in win || nav.maxTouchPoints > 0;
  const webxr = typeof (nav as unknown as { xr?: unknown }).xr !== 'undefined';
  const webgpu = typeof (nav as unknown as { gpu?: unknown }).gpu !== 'undefined';
  const webgl2 = (() => {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  })();
  const memoryGB = (nav as unknown as { deviceMemory?: number }).deviceMemory;

  const isQuest = /OculusBrowser|Quest/i.test(ua);
  // visionOS Safari masquerades as macOS Safari; macOS Safari ships WebXR *disabled*, so
  // "Macintosh + WebKit-only + navigator.xr present" is our Vision Pro heuristic (verify on device).
  const isWebKitOnly = /AppleWebKit/.test(ua) && !/Chrome|CriOS|Firefox|FxiOS|Edg/.test(ua);
  const isVisionPro = /VisionOS|Vision Pro/i.test(ua) || (/Macintosh/.test(ua) && isWebKitOnly && webxr);
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1 && !isVisionPro);
  const isAndroid = /Android/i.test(ua);

  let tier: Tier = 'fallback';
  if (!webgl2) tier = 'fallback';
  else if (isQuest) tier = 'quest';
  else if (isVisionPro) tier = 'visionpro';
  else if (isIOS) tier = 'iphone';
  else if (isAndroid) tier = 'android';
  else if (/Firefox/.test(ua)) tier = 'fallback';
  else if (isSoftwareRenderer()) tier = 'fallback';
  else tier = 'desktop';
  if (override && override in TIERS) tier = override;

  return { tier, ua, webgl2, webxr, webgpu, touch, dpr: win.devicePixelRatio || 1, memoryGB };
}
