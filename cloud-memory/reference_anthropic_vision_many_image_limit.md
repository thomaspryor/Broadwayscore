---
name: reference_anthropic_vision_many_image_limit
description: Anthropic vision API drops per-image size limit once a single request carries >20 images — silently 400s multi-image review scripts that add screenshots over time
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1831f984-97bb-4c07-b850-8e0c8fae0f61
  modified: 2026-07-21T02:55:36.904Z
---

Anthropic's Messages API allows images up to 8000px on the longest dimension in a normal request, but once a **single request carries more than 20 images**, the per-image limit drops to roughly 2000px longest-dimension. The error text names it explicitly: "At least one of the image dimensions exceed max allowed size for **many-image requests**."

**Why this bites incrementally-grown scripts:** a script that sends N screenshots to Claude in one message (e.g. [[feedback_ship_check_finds_real_bugs]]-style UX walkthroughs, visual-review tooling) can be correctly calibrated below the 8000px/4000px-capped tier when N < 20, then silently start failing every run months later when a feature addition pushes N past 20 — the existing per-image cap doesn't change, but the applicable tier does. `scripts/ux-walkthrough.mjs` hit this exactly: a 4000px cap calibrated at ~19 screenshots (2026-07-20) started 400ing Claude out of every run once card #239's additions pushed the matrix to 26 screenshots (2026-07-21) — silently degrading the review panel to 2 models with no error surfaced to the user, only visible in `console.error` output.

**How to apply:** before adding more images to any single Claude Vision request, check the total image count against 20. If a script's image count could grow over time (adding capture states, screenshot variants, etc.), either cap total images or cap per-image dimension at ~2000px unconditionally once there's any chance of crossing 20 — don't assume "under 8000px" is safe just because it was calibrated that way once.
