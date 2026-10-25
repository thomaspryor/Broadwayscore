---
name: feedback_includable_count_needs_full_rebuild
description: "To check \"do we have all includable reviews live\", run the actual rebuild — not a standalone isIncludableForRebuild count, which over-reports"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c08a9969-a94e-42e9-805e-6465cf116fed
---

To verify how many reviews a show *should* have live, run the actual rebuild (`node scripts/rebuild-all-reviews.js`, then count `reviews.json` entries with `assignedScore != null`). Do **NOT** estimate it by looping files through `isIncludableForRebuild(data, show, path)` standalone — that **over-counts**.

**Why:** `isIncludableForRebuild` is only ONE gate. The full `rebuild-all-reviews.js` applies several MORE exclusion passes after it: cross-show URL dedup, syndicated-duplicate detection, stale-score stripping, drift guards, circular-duplicate resolution, and per-outlet collapsing. A file can pass `isIncludableForRebuild` yet still be dropped by the rebuild. 2026-06-28: a standalone includable count said War Horse=33 / Beetlejuice=36; the real rebuild produced 26 / 29 (the live, correct numbers). I chased phantom "missing" reviews + re-triggered rebuilds for nothing.

**How to apply:** When asked "are we sure we have all the reviews" or measuring discovery-sweep yield, the source of truth is the rebuild output / the live slim `rc`, not a standalone includability scan. Standalone `isIncludableForRebuild` is fine for a single-file "will THIS survive the first gate" check, but never sum it as the expected live count. Related: [[feedback_includability_predicates_must_be_canonical]], the census completeness audit ([[postmortem_sinatra_review_gaps]]) keys "complete" off `assignedScore != null` in reviews.json for exactly this reason.
