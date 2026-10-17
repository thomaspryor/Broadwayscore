---
name: wrongArticle + temporal override = missing wrongProduction flag
description: When wrongArticle fires + temporal override runs on opening night, top-level wrongProduction is never set, causing poller to skip re-discovery of real reviews
type: feedback
originSessionId: 509bd5c9-9833-4424-828c-2359d5fb8c13
archived: true
---
When `contentVerification.wrongArticle=true` is detected AND a review is within 1 day of opening (temporal override active), the top-level `wrongProduction` flag is silently not set. This causes the poller to treat that outlet as "already found" and skip searching for the actual review.

**Why:** Two failure modes compound: (1) `wrongArticle` handler nulls `fullText` first; (2) temporal override downgrades confidence to `"low"`; (3) the `wrongProduction` block at line 4690 of `collect-review-texts.js` requires `isHighConfidence && data.fullText` — both fail simultaneously.

**Fixed in:** commit 61acfeb40c — `wrongArticle=true` now bypasses both requirements.

**How to apply:** On opening night, if a T1/T2 outlet shows up in `foundIds` but has no real review score, check whether the file has `contentVerification.wrongArticle=true` without a top-level `wrongProduction` or `wrongShow` flag. Also check for `rejectionReason: not_a_review` — that also leaves the outlet in `foundIds` (only `wrongProduction/wrongShow` exclude from `foundIds`, not `incompleteReason` or `rejectionReason`).
