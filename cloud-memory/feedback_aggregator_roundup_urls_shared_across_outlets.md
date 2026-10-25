---
name: feedback_aggregator_roundup_urls_shared_across_outlets
description: "Aggregator roundup URLs (westendtheatre.com, show-score.com, stagedoor.com…) are shared across every real outlet they cover — every domain→outlet contamination check must exempt them, and the canonical sets live in scripts/lib/aggregator-domains.js"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8972d744-dde4-48aa-bfa8-6c4e7221754a
---

A West End star-stub for The Telegraph discovered via the westendtheatre.com roundup
legitimately carries the WET roundup URL (with the aggregator star rating) until the
outlet's own URL is resolved — or forever, since the star is the value. The SAME
roundup URL appears on the FT, Time Out, Guardian, etc. star-stubs for that show. So
a roundup URL is inherently many-to-one: domain→outlet matching does not apply to it.

Any check that compares a review's `outletId` to its URL's domain MUST exempt
aggregator roundup URLs, or it false-positives on every legit star-stub. This bit
the project in at least 4 places, all of which must stay consistent:
- gather-reviews.js createReviewFile — TWO guards: `domainMismatch` (has the original
  `isAggregatorSource` exception) and the newer `aggregator_url_mismatch` write guard
  (`shouldSkipAggregatorUrlWrite`: value-first + source-aware).
- validate-review-texts.js — `aggregator_url_mismatch` ERROR (uses AGGREGATOR_DOMAINS).
- audit-review-contamination.js class C `C_domain_mismatch` — exempts via
  `isOutletDomainMismatch()` when the URL domain resolves to an AGGREGATOR_OUTLET_ID
  (added 2026-06-22 after 12 WET false-positives reddened Data Validation).

**Why:** the contamination to actually catch is a real outlet's review pointing at the
WRONG REAL outlet's domain, or a contentless serp-discovery stub on an aggregator
domain. A real-outlet star-stub carrying its source aggregator's roundup URL + a star
score is NOT contamination.

**How to apply:**
- Canonical sets are in `scripts/lib/aggregator-domains.js`: `AGGREGATOR_DOMAINS`,
  `AGGREGATOR_OUTLET_IDS`, `isAggregatorReviewSource()`, `isAggregatorUrlMismatch()`,
  `shouldSkipAggregatorUrlWrite()`, `isOutletDomainMismatch()`. Reuse these — never
  re-list aggregator domains/outlets/sources inline (they drift apart otherwise).
- Exempt by checking the URL domain resolves to an aggregator OUTLET (the roundup-URL
  signal), and/or the review `source` is an aggregator source, and/or it carries
  aggregatorStars. Value-first: never delete/flag a star-stub that has a score.
- KNOWN GAP: AGGREGATOR_DOMAINS still lists `westendtheatre.co.uk`; the LIVE WET domain
  is `westendtheatre.com`. validate-review-texts.js's aggregator_url_mismatch therefore
  does NOT cover WET `.com`. Adding `.com` there is risky — it would flag existing legit
  WET star-stubs as ERRORs. The audit-review-contamination class C exemption (via
  AGGREGATOR_OUTLET_IDS) is the safety net for `.com`. Decide deliberately before
  touching AGGREGATOR_DOMAINS.

Incident 2026-06-22 (Notion 386637c5-416f-81c7). Links:
[[feedback_value_first_delete_and_guard_symmetry]], [[feedback_paywalled_star_outlets_not_gaps]]
