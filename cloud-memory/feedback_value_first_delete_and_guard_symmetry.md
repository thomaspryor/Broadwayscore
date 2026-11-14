---
name: feedback_value_first_delete_and_guard_symmetry
description: Bulk-deleting review-text stubs and adding write-guards must be VALUE-FIRST and symmetric with the sibling guard — never drop a file/write that carries a score
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8972d744-dde4-48aa-bfa8-6c4e7221754a
---

A two-part change (block aggregator-URL stubs in gather-reviews.js + clean up 1811
Unknown-critic stubs) shipped two versions of the SAME value-blind bug, both caught
only by /ship-check + a review challenge:

1. **Cleanup deleted scored reviews.** The triage treated `aggregator_url_mismatch`
   as sufficient-to-delete regardless of content. 8 legit aggregator star-stubs with
   real scores (originalScore/llmScore/fullText) were deleted, then restored from
   `origin/main~N`. Also the value-signal field list was incomplete (missed
   showScoreExcerpt/stagedoorExcerpt/lboRoundupExcerpt) and a non-review-URL regex
   matched real review slugs (closing/announce//news/).
2. **Prevention guard would have blocked legit writes.** The new createReviewFile
   guard blocked ALL aggregator-domain-URL + real-outlet writes with NO exception —
   but the ADJACENT domainMismatch guard already had an `isAggregatorSource`
   exception, because aggregator-sourced reviews (stagedoor/show-score/dtli/
   westendtheatre/theatre-reviews) legitimately carry the aggregator roundup URL at
   ingest and often a real star score. The guard would have dropped WE star ratings.

**Why:** A skip/delete predicate that keys only on a "bad" signal (mismatch URL,
"contentless" tier) without also checking for VALUE (any score/stars/excerpt/text)
destroys data. And a new guard placed next to an existing one must inherit its
exceptions — the existing guard's `isAggregatorSource` carve-out IS the spec.

**How to apply:**
- VALUE-FIRST: never delete a review-text file, or block a write, that has any
  score/stars/excerpt/text. Source the value-signal field list from
  review-text-scoreable.js + content-quality.js — don't hand-roll it. A URL-mismatch
  on a file WITH a score is a URL-nulling task, not a delete.
- GUARD SYMMETRY: before adding a guard, read the sibling guards in the same function.
  If one has a source/type exception (e.g. `isAggregatorSource`), yours almost
  certainly needs it too. Extract the shared predicate to lib/ (here:
  isAggregatorReviewSource + shouldSkipAggregatorUrlWrite in aggregator-domains.js).
- "non-review URL" = social/video HOSTS via a hostname set, never slug-word substrings.
- Before `--execute` on any bulk delete: recover a SAMPLE of candidates' ACTUAL
  content (`git show <ref>:path`) and assert no score/excerpt/text. A /tmp report from
  minutes ago is not proof of on-disk state.
- gh api content writes share the 5000/hr core limit AND trip a secondary write limit
  fast — batch with backoff; `gh api rate_limit` (free) to check reset.

Incident 2026-06-21 (Notion 380637c5-416f-813e / -81af). Links:
[[feedback_paywalled_star_outlets_not_gaps]], [[feedback_includability_predicates_must_be_canonical]],
[[feedback_investigate_premise_before_scaling]]
