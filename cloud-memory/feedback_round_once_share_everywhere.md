---
name: Round once, share everywhere for display-driven UI gates
description: "Every gate on a rounded score must round too; centralize in isCriticalGold()."
type: feedback
originSessionId: 478f21b8-926e-47bb-bde6-6edd76d9c4c4
---
When UI displays `Math.round(score)` but a subsequent gate (crown, glow, tier color) compares raw `score >= threshold`, scores in the `[threshold-0.5, threshold)` band render inconsistently: color says one tier, crown/glow says another.

**Why:** 2026-04-14 homepage bug — Becky Shaw (raw 82.68) rendered "83" in gold but without a crown because `FeaturedRowServer` and `MiniShowCard` gated the crown on raw score while `getScoreTier` rounded for color. 11 shows were in the affected 82.5–82.99 band.

**How to apply:**
- Never inline `score >= threshold` in a UI component when the displayed value is rounded. Wrap in a helper (e.g. `isCriticalGold(score, category)` in `src/config/score-buckets.ts`) that always rounds internally.
- Route every new callsite through the helper — grep for `>= getGoldThreshold` periodically to catch drift.
- Pre-truncated inputs (`parseInt(searchParams.get(...))`, integer per-review scores) are safe to inline, but reviewers will still flag them — route through the helper anyway to kill the false positive.
- The class-of-bug to watch for: anywhere display formatting (rounding, clamping, abs) is applied AFTER reading the source value, and the threshold check reads the unformatted source.
