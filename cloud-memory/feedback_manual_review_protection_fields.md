---
name: Manual review protection fields
description: ingest-manual-review.js must set ALL protection fields or guards re-flag the review
type: feedback
---

Manual review ingestion (ingest-manual-review.js / /manual-review skill) must set ALL of these fields:
- humanReviewScore (survives rebuild scoring)
- manualContentTier: "complete" (survives contentTier reclassification)
- wrongProduction: false
- wrongProductionManualClear: true
- allowEarlyDate: true
- wrongShow: false
- contentVerification.wrongProduction: false
- contentVerification.wrongArticle: false

**Why:** Missing any ONE field means a different rebuild guard re-flags the review. NYTG/Guardian reviews were lost multiple times on becky-shaw opening night because only humanReviewScore+manualContentTier were set, and the CV pre-pass or wrongProduction guards re-flagged them.

**How to apply:** All these fields are now set automatically in ingest-manual-review.js. When manually editing review files, check all 8 fields.
