---
name: tony-accuracy-from-summaries
description: "Always derive Tony prediction accuracy from getSeasonSummary() data, not computeBlendedAccuracyStats — the latter is stale relative to current TONY_RECIPES recipes"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 64fdf6b6-712e-4300-add7-1d0afef97a42
---

When displaying Tony prediction accuracy on any page, **derive the count from `getSeasonSummary()` / `categoryHighlights` data**, not from `computeBlendedAccuracyStats()`.

**Why:** `computeBlendedAccuracyStats()` runs through a parallel scoring path that doesn't always reflect the current `TONY_RECIPES` weights. The visible UI (Track Record component, season picks) uses `groupIntoCategories()` → `serializeShow()` → `tonyComposite()` with the current recipes. The two paths drift. During 2026-05-23 session, this caused the umbrella page FAQ schema and season-page collapsed-summary line to show ~77-86% accuracy while the visible Track Record showed 90.7% — same model, two different code paths, different numbers.

**How to apply:** anywhere you need accuracy stats for display:

```ts
let hits = 0;
let cells = 0;
for (const sum of summaries) {
  if (!sum.hasTonyResults) continue;
  for (const h of sum.categoryHighlights) {
    if (!h.winnerTitle) continue;
    cells++;
    if (h.topShowTitle && h.winnerTitle === h.topShowTitle) hits++;
  }
}
const pct = cells > 0 ? Math.round((hits / cells) * 1000) / 10 : 0;
```

Use this for FAQ schema text, accuracy summaries, methodology blocks, and any user-facing number. The TrackRecord component (`src/components/tony/TrackRecord.tsx`) already does this — reuse the same pattern.

`computeBlendedAccuracyStats` is still useful for the side-by-side critic-only-vs-blended comparison (where the consistent scorer matters for the comparison), but the headline accuracy number must match what users see.

Verified by: `scripts/audit-tony-all-seasons.ts` agrees with the summaries-derived count (39/43 = 90.7% as of 2026-05-23).
