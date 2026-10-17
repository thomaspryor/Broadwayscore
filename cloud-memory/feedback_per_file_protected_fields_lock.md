---
name: Per-file protectedFields array as poller/CI overwrite lock
description: When override fields aren't in global PROTECTED_FIELDS, set a per-file `protectedFields` array on the review-text JSON to force them through push-review-texts merges.
type: feedback
originSessionId: e21cf611-958e-43e9-b905-cbd9f28d4eda
archived: true
---
scripts/lib/review-write-guard.js `getEffectiveProtectedFields()` unions the global `PROTECTED_FIELDS` array with any per-file `protectedFields` array in the JSON. Use this as a short-term workaround when a custom override field isn't in the global list and CI pushes are overwriting it.

**Shipped on 2026-04-23 Beaches opening night:**
- Manually ingested 21 Beaches reviews with override fields: `allowTourSignal`, `humanReviewScoreProvisional`, `wrongProductionManualClear`, `humanReviewedWrongProduction`, etc.
- Several of these are NOT in the global `PROTECTED_FIELDS` array.
- Every subsequent poller / scoring / rebuild run that rebased review-texts would have stripped these fields.
- Fix: added `"protectedFields": ["allowTourSignal", "allowFilmSignal", "allowEarlyDate", "humanReviewScoreProvisional", "humanReviewScoreClearedForLlm", "humanReviewNote", "humanReviewedWrongProduction", "humanReviewedTour", "humanReviewedWrongArticle", "wrongProductionManualClear", "isTourReview", "isLikelyTourReview"]` array to each of the 21 files.
- Survived 14+ polling cycles through the night without losing any override.

**How to apply:** When manually ingesting an opening-night review batch, ALWAYS set per-file protectedFields listing ALL the override fields you're setting. Verify `getEffectiveProtectedFields()` picks them up: `node -e "const {getEffectiveProtectedFields} = require('./scripts/lib/review-write-guard'); console.log(getEffectiveProtectedFields(JSON.parse(require('fs').readFileSync('data/review-texts/SHOW/FILE.json'))));"`.

**Permanent fix:** add these fields to the global `PROTECTED_FIELDS` in scripts/lib/review-write-guard.js so per-file arrays aren't needed. Tracked in P0 card 34b637c5-416f-8138-9df5-e638a7716be1.
