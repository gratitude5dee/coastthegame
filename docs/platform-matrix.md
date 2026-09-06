# Platform matrix (living doc — mirrors goal.md §5; update with /perf evidence)

| | Desktop Chrome/Edge | Meta Quest 3/3S | iPhone 15+ Safari 26 | Apple Vision Pro Safari | Android Chrome |
|---|---|---|---|---|---|
| Renderer | WebGL2 + Spark | WebGL2 + Spark (WebXR immersive-vr / immersive-ar) | WebGL2 + Spark (no WebXR) | WebGL2 + Spark (immersive-vr) | WebGL2 + Spark (+immersive-ar) |
| Target fps | 60 | 72 Hz stereo | 30 min / 60 target | 90 | 45–60 |
| `lodSplatCount` | 2.5M | 750K → 1M with evidence | 750K | 750K | 750K |
| Input | KB/M, gamepad, webcam hands, voice | controllers, WebXR hands, voice | touch sticks, gyro, voice, webcam hands | gaze + pinch, voice | touch, hit-test |
| Perspectives | actor / director / producer(overhead) | actor / director / producer(diorama) | all (overhead) | all (diorama) | all |
| Capture | upload | passthrough room scan + phone photos | guided photo capture (primary) | — | guided capture |
| Grounding | map pin → 3D Tiles | anchors, planes/meshes, depth hit-test | GPS/compass/orientation + QR | — | ARCore hit-test/anchors |
| Dream (live) | yes | experimental | no | no | no |
| Post | full | grade | grade | grade | grade |
| Known blockers | — | WebGPU-in-XR flag only; 8 anchors/site | no `navigator.xr`; motion permission on gesture | hand joints not guaranteed; no AR | fragmentation |
