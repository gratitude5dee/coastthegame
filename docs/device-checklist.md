# Real-device checklist (perf evidence for QB gates)

Headless SwiftShader screenshots prove correctness, never performance. For every milestone gate from M3 on, run this on each device and let the app POST its report to `/api/perf/report` (the in-app `/perf` route shows the numbers live).

| Device | Browser | What to run | Pass |
|---|---|---|---|
| Desktop (RTX 3060-class or M2) | Chrome/Edge latest | `/?cell=pier` 90 s walk + drive | p95 ≥ 60 fps @1080p, first frame ≤5 s |
| Meta Quest 3 | Quest Browser latest | Enter VR at Garage → walk to Pier → hands paint | 72 Hz stereo p95, frame ≤13.7 ms, no reprojection spikes |
| iPhone 15+ (iOS 26) | Safari | `/?cell=pier` touch walk + lowrider | ≥30 fps min, 60 target, no thermal throttle in 5 min |
| Apple Vision Pro | Safari | Enter VR, gaze+pinch select, diorama | 90 Hz target, ≥72 sustained |
| Android flagship | Chrome | touch + `immersive-ar` placement | ≥45 fps |

Report fields: `{tier, ua, gpu, cell, splatCount, fps:{p50,p95}, frameMs:{p50,p95,max}, memoryMB, sessionS, notes}`. Save summaries under `docs/perf/<date>-<device>.md` (JSON stays in R2).
