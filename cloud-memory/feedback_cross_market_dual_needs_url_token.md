---
name: cross-market-dual-needs-url-token
description: "same-season cross-market same-title contamination — dual-market outlets need URL cast/venue token corroboration (region can't disambiguate); A2 detector + bake-promote routine"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a738e0c7-f019-40de-89dd-f6f4f8ecc46a
---

A review of one production can be scored on a same-title SIBLING production in the other market (West End ⟷ NYC). The pre-existing Category-A detector in `audit-review-contamination.js` only caught these when the review was >180d from this show's opening, so SAME-SEASON siblings slipped through: 4 West End *Romeo & Juliet* reviews (Sadie Sink/Noah Jupe, opened 2026-03-31) inflated the off-Broadway Delacorte production (opened 2026-06-11, ~72d apart) — user report #382, 2026-06-26. The reverse also happened (a Delacorte review on the West End show).

**Root cause of the leak (already fixed 2026-06-21):** the `audit-aggregator-gap` ingest (`ingest-review-from-url.js`) stamped fake operator-override fields (`allowCrossMarket`/`wrongProductionOverride`/`wrongProductionManualClear`) onto machine-ingested reviews, exempting them from every guard. The `operatorTrust` gate in `manual-review-fields.js` stops new cases. To fix EXISTING contaminants you must strip those override fields AND set `wrongProduction:true` + a manual `wrongProductionReason` (else `shouldAutoClearWrongProduction` re-admits on rebuild).

**Detection lesson (shipped as `classifyCrossMarketContamination` in `scripts/lib/cross-market-guard.js`, report-only bucket A2):** flag when the review date-clusters (<=30d) with a cross-market sibling's opening AND is >=45d farther from this show, REQUIRING corroboration — never date alone:
- **region mismatch** only corroborates for NON-dual-market outlets (London outlet on a US show whose sibling is WE).
- **dual-market outlets (Guardian/Times-UK/Telegraph) can't be disambiguated by region** — they legitimately cover both markets — so they need URL cast/venue **token** corroboration. Match tokens on SLUG BOUNDARIES, not substring (else "hall" matches "marshall", "globe" matches "theglobeandmail"); skip common-word surnames.

A2 is report-only; cloud routine `trig_01VZTtr8qYv95gjmbejXYbUk` (2026-07-05) promotes it to the strict gate ONLY if still clean. Same-MARKET same-title contamination needs no new detector (surface ~empty; existing >180d + date/URL-year guards cover it). Related: [[feedback_same_title_disambiguation]], [[feedback_manual_review_protection_fields]], [[feedback_audit_contamination_strict_mode]].
