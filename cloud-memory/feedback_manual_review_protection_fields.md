---
name: manual-review-protection-fields
description: ingest-manual-review.js must set ALL protection fields or guards re-flag the review
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 87c1ed58-1c74-4a64-aee8-186bb07c4dac
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
- **stale CV neutralized + wrongShowReason removed** (added 2026-07-11): if the
  file's body was ever replaced, the old contentVerification verdict
  (isValid:false, issues, reasoning) describes a body that no longer exists —
  and the REBUILD re-promotes wrongShow from cv/wrongShowReason DESPITE
  wrongShowManualClear ("rebuild: promoted via wrongShowReason fallback (stale
  cv)"). Setting only cv.wrongProduction/cv.wrongArticle false is NOT enough.
  Replace the whole cv block with a manual verdict ({isValid:true,
  confidence:'manual', verifiedBy:'manual-<date>', reasoning:<why>}) and delete
  wrongShowReason + contentVerificationPromoted. Incident: evening-all-afternoon
  + here-there-are-blueberries Guardian recoveries stayed suppressed through a
  full rebuild until the stale CV was neutralized (review-texts e0bfc495).

**Why:** Missing any ONE field means a different rebuild guard re-flags the review. NYTG/Guardian reviews were lost multiple times on becky-shaw opening night because only humanReviewScore+manualContentTier were set, and the CV pre-pass or wrongProduction guards re-flagged them.

**How to apply:** All these fields are now set automatically in ingest-manual-review.js. When manually editing review files, check all 8 fields.
