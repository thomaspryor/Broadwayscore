---
name: explainexclusion-is-a-mirror-not-the-real-gate-edit-rebuild-all-reviews-js-too
description: "Editing scripts/lib/review-guards.js's explainExclusion/isIncludableForRebuild alone does NOT change what lands in reviews.json — rebuild-all-reviews.js's own inline per-file loop has separate, duplicated exclusion checks that must be patched too. scoring-delta.js's \"0 flips\" can be a false negative for this exact reason."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5cabaa98-649e-4330-8dc2-20e14929283a
  modified: 2026-09-16T07:23:30.931Z
---

**Rule:** Any exclusion-logic change intended to affect `reviews.json` must be verified against `scripts/rebuild-all-reviews.js`'s own per-file build loop (~line 3900-4050 area, search for `logExclusion(` call sites), not just `scripts/lib/review-guards.js`'s `explainExclusion()`. That function's own doc comment calls it a "mirror" of the real loop — but before BRO-2282, two existing exceptions inside it (`isJsonLdStarNotAReview`, `hasIndependentExcerptScore`, both guarding the `rejectionReason`/`rejectedAt` checks) were dead code: `rebuild-all-reviews.js` line ~3985 was a blunt `if (data.rejectionReason) { skip }` with zero exceptions, and never imported either helper. Nobody had noticed because `explainExclusion`/`isIncludableForRebuild` ARE genuinely called elsewhere in `rebuild-all-reviews.js` (duplicateOf-chain recovery, `bylineRecoveryRecords` stats) — just not for the main per-file inclusion decision on every gate.

**Why:** `scoring-delta.js` (the mandatory CLAUDE.md rule 12.7 check) replays `explainExclusion`-equivalent logic and reports "0 flips" — which is true for the mirror, and says nothing about the real build. Its own banner text already warns about this exact failure mode (task #1926: a check landed only in review-guards.js, scoring-delta reported 0 flips, and a direct corpus scan found 722 reviews across 78 outlets would flip once wired into the real loop) and demands a direct corpus scan against the actual changed condition in rebuild-all-reviews.js whenever the diff lands near a `logExclusion(...)` call site. Read that banner when it fires — don't just note "Phase A/B clean" and move on.

**How to apply:** When adding/changing an exclusion escape hatch:
1. Add it to `review-guards.js` (`explainExclusion`, and `isRejectedNonReview` if the discovery/rediscovery layer needs to stay in lock-step — but see the second finding below).
2. Grep `rebuild-all-reviews.js` for the matching `logExclusion("skipped<X>"` call and patch its guarding `if` to call the SAME new predicate, imported from `review-guards.js`.
3. Run a direct corpus scan (`require()` the predicate, iterate every file under `data/review-texts/*/*.json`, count what flips) — this is the only thing that actually proves the real gate changed, per scoring-delta's own advice.
4. Don't stop at scoring-delta's "0 flips" if it flagged "CANNOT AUTO-VERIFY" — that banner means do the manual scan, not that you're done.

**Second, related finding (also BRO-2282):** when adding an exception to `isRejectedNonReview` (the discovery/rediscovery-blocking predicate), scope it to ONLY the specific branch your new signal actually clears (e.g. `NON_REVIEW_REJECTION_REASONS.has(...)`) — do NOT `return false` early for the whole function. That function has several INDEPENDENT non-review signals below the rejectionReason check (`cv.wrongArticle` high-confidence, `NON_REVIEW_CV_ARTICLE_TYPES`, `contentTier==='invalid'`) that your new exception has no authority over; an early return silently bypasses all of them too, which can mark a file "retrieved" (stop rediscovery) while `explainExclusion` still excludes it from scoring via one of those OTHER checks — a permanently missing review the pipeline believes is covered. Caught by an adversarial Codex `/ship-check` pass, not by the first-pass plan review or by any existing test.
