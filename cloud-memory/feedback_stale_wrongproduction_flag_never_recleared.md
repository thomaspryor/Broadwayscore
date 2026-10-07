---
name: feedback_stale_wrongproduction_flag_never_recleared
description: Rebuild short-circuits on d.wrongProduction so a date-corrected pre-opening flag is never re-evaluated — genuine reviews stay excluded forever
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 16d96be1-473b-4d44-b95b-e6ffb581510d
---

The rebuild's dated pre-opening guard (`rebuild-all-reviews.js`) SETS
`wrongProduction:true` + a `Pre-opening guard: ...` note when a review's date is
90+ days before the show. Then `if (d.wrongProduction || d.wrongShow) continue;`
short-circuits the whole guard block — so once flagged, the rebuild NEVER
re-evaluates the date guard. When the date is later corrected to an in-window
date (adjudication / re-scrape), the stale flag silently keeps a genuine review
out of the rebuild forever. Found 2026-06-28: **175 reviews** corpus-wide,
including all-my-sons-west-end-2025 Guardian/Arifa Akbar (real 2025-11-22 review
held by a long-gone 2025-07-01 date), Tina 2019 (WashPost/NYPost/NYDN), Torch
Song 2018 (Vulture/EW).

**Why:** the existing auto-clear paths only covered priorRuns-window coverage and
dateless-revival-hold-release. Nothing covered "the date itself is now valid." A
SET-only guard with no re-clear is a one-way ratchet — every transient bad date
becomes a permanent exclusion.

**How to apply:** when adding any flag-SETTING guard to the rebuild, add the
matching CLEAR path that runs BEFORE the `continue` short-circuit and
re-evaluates the original predicate on current data. Fix shipped:
`shouldAutoClearStaleDateGuard()` in `scripts/lib/wrong-production-autoclear.js`
(pure fn — caller passes `evaluateDateGuard().flag===false` to avoid a circular
require on date-guard) + a rebuild block that re-runs `evaluateDateGuard` on the
current `reviewDate` and clears only the dated guard's own flag (note prefix
`Pre-opening guard:`). To audit corpus-wide:
`evaluateDateGuard({pubDate, show, outletId}).flag === false` on every
`wrongProduction` file whose note starts with `Pre-opening guard:`. Related:
[[feedback_manual_review_protection_fields.md]], [[feedback_duplicate_of_url_mismatch.md]].
The same SET-without-CLEAR smell also bites self-referential `duplicateOf` (a
file marked duplicate of itself, 145 corpus-wide) — now self-healed in
`review-write-guard.js` with a `duplicateClearReason` breadcrumb.
