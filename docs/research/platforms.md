# Platform constraints (2026-09-06)

## 1. WebXR on iPhone / visionOS Safari
- **iPhone/iPad: no WebXR.** caniuse lists WebXR unsupported in Safari iOS 3.2–26.6, disabled-by-default on macOS ([caniuse](https://caniuse.com/webxr)). Safari 26.0/26.2/26.4/26.6 and Safari 27 beta add nothing for iOS WebXR ([Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)); handheld AR not exposed ([XRDoctors](https://xrdoctors.pro/blog/webxr-on-ios-what-actually-works)).
- Apple added the `<model>` element (USDZ viewer) on iOS/macOS in Safari 27 beta; visionOS 27 adds immersive website environments — viewers, not runtimes.
- iPhone AR paths: AR Quick Look / USDZ (`model-viewer` `ar-modes="quick-look"`); **8th Wall hosting ends Feb 28 2027** (engine open-sourced MIT without VPS/hand tracking; SLAM as a binary) ([forum](https://forum.8thwall.com/t/important-changes-to-8th-wall-business/8578), [Road to VR](https://roadtovr.com/niantic-webar-platform-8th-wall-open-source/)); **Variant Launch** App Clip injects real WebXR into Safari ($99–199/mo/project) ([site](https://launch.variant3d.com/)); "poor man's AR" = `getUserMedia` + `DeviceOrientationEvent.requestPermission()` (3DoF, secure context).
- **visionOS Safari:** `immersive-vr` on by default since visionOS 2; no `immersive-ar`; input = `transient-pointer` (gaze + pinch); hand joints not guaranteed in practice ([WebKit](https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/), [Babylon thread](https://forum.babylonjs.com/t/webxr-hand-tracking-error-on-safari-vision-pro/47849?page=3)); Safari 26.2 added WebXR-on-WebGPU on visionOS ([26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/)). Spark lists Vision Pro as a WebGL2 target; Gracia streams 4DGS in WebXR on Vision Pro/Quest 3.

## 2. WebGPU
- Implementation status (Aug 13, 2026): Chrome 113+ desktop; Android from Chrome 121; **Safari 26 on by default** (macOS/iOS/iPadOS/visionOS); Firefox 141 Win / 145 macOS ([gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). Baseline since Jan 2026.
- **Quest Browser:** WebGPU on 2D canvases since v32; **WebGPU inside WebXR is experimental/flag-gated** (146.0 Apr 2026 … 150.1 Aug 2026 foveation) ([Meta release notes](https://developers.meta.com/horizon/release-notes/web/)). WebXR/WebGPU binding Editor's Draft June 2026.
- **three.js WebGPURenderer** XR sessions historically WebGL2-backend only (`forceWebGL`), multiview bugs on Quest at r181 ([#32538](https://github.com/mrdoob/three.js/issues/32538)); tracking issue [#28968](https://github.com/mrdoob/three.js/issues/28968). **three.js r186 (Aug 2026) ships a native WebGPU/TSL splat renderer** (PLY/SPZ/SPLAT/KSPLAT/glTF; SH0 only; no LoD/streaming) ([Radiance Fields](https://radiancefields.com/three.js-merges-a-native-gaussian-splat-renderer-for-webgpu-in-r186)). Spark 2.0 stays WebGL2-only.

## 3. Meta Quest Browser WebXR
- Hands: 25 joints/hand, pinch as emulated Gamepad button ([Meta hands](https://developers.meta.com/horizon/documentation/web/webxr-hands/)). Layers cut GPU cost 3.15 → 0.72 ms in Meta's test ([layers](https://developers.meta.com/horizon/documentation/web/webxr-layers/)).
- Passthrough `immersive-ar`, plane detection via `initiateRoomCapture()`, persistent anchors (max 8/site) ([MR](https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/)); mesh detection with semantic labels via IWSDK ([scene understanding](https://developers.meta.com/horizon/documentation/web/iwsdk-guide-scene-understanding/)); depth-API hit-test on Quest 3/3S without scene mesh (Browser 40.4) ([UploadVR](https://www.uploadvr.com/quest-browser-depth-api-webxr-hit-testing-instant-placement/)); experimental shared spatial anchors (flag, Quest-only).
- Perf: default 72 Hz Quest 3 (13.7 ms), `updateTargetFrameRate()`; framebuffer scale 0.8–0.9, FFR, multiview ([frames](https://developers.meta.com/horizon/documentation/web/webxr-frames/), [perf](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/)). Splats: Spark guidance Quest 3 ≤1M, `maxStdDev=√5`, `antialias:false` ([Spark perf](https://sparkjs.dev/docs/performance/)); HoloLab ran 40M-splat LoD scenes on phones/Quest; SuperSplat scenes "run poorly" without presets ([issue](https://github.com/playcanvas/supersplat-viewer/issues/8)). Assume ~1M visible at 72 Hz stereo.

## 4. Geospatial / localization
- **Google Photorealistic 3D Tiles:** $6/1,000 root tileset requests (0–100k), 1,000 free events/mo, 10,000 root/day cap ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [usage](https://developers.google.com/maps/documentation/tile/usage-and-billing)); **no caching/offline, attribution required, overlays must not be derived from tiles, no geodata extraction** ([policies](https://developers.google.com/maps/documentation/tile/policies)); three.js loader NASA-AMMOS `3DTilesRendererJS` (Apache-2.0) ([repo](https://github.com/NASA-AMMOS/3DTilesRendererJS)).
- ARCore Geospatial: native only ([Google](https://developers.google.com/ar/develop/geospatial)); `ARGeoAnchor` native ARKit only. **Niantic Spatial** NSDK 4.x Unity/Swift/Kotlin/ROS; VPS 2.0 (~1 cm in Scaniverse-mapped areas) — no JS SDK ([NSDK](https://www.nianticspatial.com/docs/nsdk/)). Meta web: anchors/planes/meshes/depth; shared anchors experimental.
- Recommendation: 3D Tiles for exploration only; pre-baked splats for play; Quest anchors + mesh + depth for room registration; phones GPS+compass (3–5 m) + QR/image-target beacons.

## 5. Hands
- WebXR Hand Input (Quest; Android XR Chrome lists hands as primary input ([Android XR](https://developer.android.com/develop/xr/web))); visionOS gaze+pinch in practice.
- MediaPipe Hand Landmarker (`@mediapipe/tasks-vision`): 21 landmarks + world landmarks; `detectForVideo()` blocks main thread → Worker; WebGL delegate only ([guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)).

## 6. Infra
- **Cloudflare:** Workers static assets preferred over Pages ([migration](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)); **25 MiB per static file**, 20k/100k files, 64 MiB bundle, body 100 MB (Free/Pro) ([limits](https://developers.cloudflare.com/workers/platform/limits/)). **R2:** 5 GiB single PUT, ~5 TiB multipart; $0.015/GB-mo; zero egress; free 10 GB ([R2](https://www.cloudflare.com/products/r2/)). **Durable Objects:** SQLite-backed, free tier 100k req/day; WebSocket hibernation ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing)). **Workers AI:** image gen (FLUX, SDXL), LLMs, Whisper — **no 3D/splat models** ([models](https://developers.cloudflare.com/workers-ai/models/)).
- **thirdweb:** User Wallets (email/phone/passkey/social), SIWE, Contracts, Engine, IPFS Storage, x402 ([site](https://thirdweb.com/), [wallets](https://portal.thirdweb.com/wallets/users)); pricing Growth $99/mo…; **Solana: frontend SDK discontinued Oct 2023; 2025 re-entry is server-side only** (server wallets, SPL deploys) — no user wallets/social login/NFT minting on Solana ([blog](https://blog.thirdweb.com/discontinuing-solana-support/), [API](https://blog.thirdweb.com/changelog/introducing-solana-support-in-thirdweb-api/)). For Solana users: **Phantom Connect** (embedded wallets, Google/Apple login) ([docs](https://docs.phantom.com/wallet-sdks-overview)), Privy, Dynamic, Web3Auth, Crossmint; mint via Metaplex.

## 7. GTA VI
Launch **Thursday, November 19, 2026** on PS5 / Xbox Series X|S; no PC date ([Rockstar](https://www.rockstargames.com/newswire/article/ak3ak31a49a221/grand-theft-auto-vi-is-now-set-to-launch-november-19-2026)); pre-orders opened June 25, 2026; Netflix "Extended Look" Aug 27, 2026. **No Rockstar Editor / Director Mode / creator tooling announced** — only rumors of a "Creator Platform" team and the FiveM acquisition.

## 8. The bar (2025–2026)
1. **Starspeed** — multiplayer zero-G combat streaming 100M+ splats via Spark 2.0 LoD — https://starspeed.game/
2. **Dormant Memories** (smallfly) — splat scans with reveal effects — https://www.smallfly.com/dormant_memories/
3. **HoloLab Spark demos** — 40M-splat scenes on phones/Quest — https://works.lilea.net/spark/
4. **Into the Scaniverse** (Niantic) — 50k+ community splats, WebXR on Quest 3 — https://www.intothescaniverse.com
5. **Gracia × DNE "Open"** — 4-minute streamable 4DGS performance in WebXR (Apr 2026) — https://www.cgchannel.com/2026/04/dne-and-gracia-release-4-minute-streamable-4dgs-performance/
6. **Varjo Teleport** — iPhone capture → web/VR splats — https://teleport.varjo.com/
7. **IVRESS** (Utsubo) — FWA Site of the Month May 2026; WebGPU + WebGL fallback — https://brand.ivress.co.jp/
8. **Oryzo** (Lusion) — Awwwards SOTM Apr 2026 — https://oryzo.ai/
9. **Illoca** (Unseen) — Awwwards SOTD + Developer Award Sep 4 2026 — https://illoca.unseen.co
10. **PlayCanvas SuperSplat 2.0** — open viewer with VR mode — https://github.com/playcanvas/supersplat-viewer
11. **three.js r186 native splats**, **@luma.gl/splats 9.4** — engine-level bar — https://radiancefields.substack.com/p/gaussian-splatting-in-august-2026
12. **Spatial Fields / MetalSplatter** — native Vision Pro SH quality ceiling — https://radiancefields.com/spatial-fields-free-apple-vision-pro-3dgs-with-sh

## Hard constraints → goal.md §5 / §11
iPhone tier has no `navigator.xr`; 8th Wall is ending; no web VPS anywhere; visionOS = immersive-vr + gaze/pinch; ship one WebGL2 XR path; Quest ≈1M splats at 72 Hz; Quest features gated by room scan/permissions; 3D Tiles pricing/ToS; 25 MiB static cap → R2 with Range; no server-side 3D on Workers AI; thirdweb ≠ Solana users; MediaPipe = 2D/no depth; iOS motion permissions need a gesture; target 72 Hz on Quest; no Rockstar tooling.
