# The 6 canonical shots (QB-12)

Each is a deterministic URL for the screenshot harness; Astra grades each 0–10 against the approved key art using the rubric, and logs scores in `art/DIFF.md`. GRATITUD3 spot-checks 2 of 6 per milestone. Gate: ≥8 on all six.

| id            | URL                                                         | reference key art                        |
| ------------- | ----------------------------------------------------------- | ---------------------------------------- |
| garage-golden | `/?cell=garage&cam=director&t=0&shot=1&time=golden`         | `art/concept/approved/garage-golden.png` |
| pier-golden   | `/?cell=pier&cam=director&t=4&shot=1&time=golden`           | `art/concept/approved/pier-golden.png`   |
| alley-blue    | `/?cell=alley&cam=actor&t=2&shot=1&time=blue`               | `art/concept/approved/alley-blue.png`    |
| rooftop-night | `/?cell=rooftop&cam=director&t=1&shot=1&time=night`         | `art/concept/approved/rooftop-night.png` |
| lookout-fog   | `/?cell=lookout&cam=producer&t=0&shot=1&time=fog_noon`      | `art/concept/approved/lookout-fog.png`   |
| lowrider-hero | `/?cell=pier&cam=low&t=6&shot=1&time=golden&focus=lowrider` | `art/concept/approved/lowrider-hero.png` |

## Rubric (score each 0–2, sum = 0–10)

1. **Palette** — dominant hues and their proportions match the key art (golden/blue/sodium/neon families).
2. **Light direction & contrast** — key light direction, shadow softness, sky/ground luminance ratio.
3. **Fog density & depth cueing** — distance falloff reads the same; silhouettes at the same depth bands.
4. **Silhouette read** — characters/lowrider/props separate from the splat base as in the art (stylized layer vs photoreal base).
5. **Material response** — chrome/candy paint/wet asphalt/wood respond to light as painted; no flat or plastic look.

A score <8 requires a written "next" action in `art/DIFF.md` before the next iteration.
