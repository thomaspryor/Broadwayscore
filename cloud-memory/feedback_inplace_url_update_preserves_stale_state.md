---
name: feedback_inplace_url_update_preserves_stale_state
description: "Writers update a review file's url in place while flags/excerpts/stars/scores from the OLD url survive — suppressed the real Guardian/Telegraph/Standard/FT JCS reviews on opening week; manual wrongShowReason flags make it WORSE"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: babb7f9a-e929-4c7f-ae30-97d1163008bf
---

On JCS Palladium opening week (2026-07-08..10), the real Guardian (pub 07-07), Telegraph, Standard, FT and Times reviews were all discovered and fetched — and all suppressed. Each was merged IN PLACE into the outlet--critic file that still carried state from the URL it used to hold (Hello Dolly contamination): wrongShow/wrongProduction flags, `westEndTheatreExcerpt` (Dolly text), `aggregatorStars` (Dolly ratings), and llmScores computed from Dolly content.

**The trap compounds with manual flags:** `wrongShowReason` is set manually precisely so auto-clears can't strip it (rebuild-all-reviews.js UK-outlet auto-clear honors it). But when the real review's URL lands in that file, the manual flag now suppresses the REAL review. Flagging a file for its URL is really flagging the URL, not the slot — the file identity (outlet--critic) outlives the URL.

**Same-day recurrences of the shape:**
- `times-uk--rachel-halliburton.json`: interview URL → manually rejected → URL updated in place AGAIN to the real Times review (0-word twin of maxwell's file, same URL) → re-included past the flags (textFetchedAt > rejectedAt lapses the rejectedAt guard).
- `guardian--arifa-akbar.json`: recovered from Dolly state, then found blocked by a stale `duplicateOf: guardian--mark-lawson.json` (2025 Watermill file, different URL — the duplicateOf-URL-mismatch bug class) — invisible until isScoreable() was run on the file directly.

**Why:** the replacement path (computeReplacementPreserve + REPLACE_CLEAR_FIELDS) exists in gather-reviews for exactly this, but only some writers route through it; others merge via safeWriteReview, whose PROTECTED_FIELDS semantics preserve flags across ALL writes including URL changes.

**How to apply:**
- When a show is missing majors whose slots hold flagged files: check whether the files' CURRENT url is already the real review (`url` + fullText mentions the show) before assuming discovery failed. The review is often sitting there suppressed.
- Recovery recipe per file: verify fullText is the real review → clear wrongShow/wrongProduction + set wrongShowManualClear/wrongProductionManualClear + allowEarlyDate → wipe ALL old-URL-derived fields (source excerpts, aggregatorStars, llmScore/llmMetadata/ensembleData, contentTier/rejection fields) → dispatch "LLM Ensemble Score Reviews" `-f show_id=` (NOT `-f show=`) → rebuild → verify-review-recovery.js.
- Unscored-but-clean file that scoring skips: run `isScoreable(data)` from scripts/lib/is-scoreable.js directly — it surfaces hidden blockers (stale duplicateOf, showNotMentioned) that no log mentions.
- Systemic fix carded (Notion 399637c5-416f-81fc): enforce "URL changed ⇒ old-URL-derived state cleared" in review-write-guard.js, the chokepoint all writers share.
- Related: [[feedback_stale_flag_collision_drops_current_production]] (NEW-file path, fixed 2026-07-04 — this is the in-place cousin), [[feedback_wet_venue_page_wrong_show_ingestion]] (how the Dolly state got there), [[feedback_duplicate_of_url_mismatch]].

**2026-07-12 addition — cross-outlet URL moves are now REFUSED entirely** (Louise Penn 'Cambridge' incident: her loureviews.blog reviews merged into a phantom SERP-label 'cambridge' slot and published her under an outlet she never wrote for). `isCrossOutletUrl(outletId, url)` in `scripts/lib/review-normalization.js` guards mergeReviews AND updateFileUrlWithInvariant (which discover-real-urls/merge-showscore-urls/rediscover-review-urls route through). Refusals log `skippedCrossOutletMerge` in the exclusion log — check there when a URL update mysteriously "didn't happen". Carve-outs: wire services (WIRE_SERVICE_OUTLETS: ap/reuters/bloomberg/upi syndicate anywhere) and the slot outlet's own registry domain/domainAliases (observer↔theguardian.com, ap↔abcnews.go.com, sunday-telegraph↔telegraph.co.uk). If a legit outlet's URL update is being refused, the fix is usually adding the host to that outlet's `domainAliases` in outlet-registry.json (both repos).
