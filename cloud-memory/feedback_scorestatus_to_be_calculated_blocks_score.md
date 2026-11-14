---
name: scoreStatus TO_BE_CALCULATED blocks getBestScore
description: Setting scoreStatus=TO_BE_CALCULATED causes getBestScore to return null immediately, skipping the review from rebuild output — even if llmScore or humanReviewScore is present
type: feedback
originSessionId: 41011087-ab38-4d77-aa60-6a75438b8601
archived: true
---
`getBestScore` in `scripts/lib/rebuild-helpers.js` (line 336) checks `data.scoreStatus === 'TO_BE_CALCULATED'` FIRST and returns null unconditionally. This is an early-exit guard that predates all score source checks.

**Why:** The flag means "this file hasn't been scored yet — skip it until the scorer runs." It's intentional, but it bites when you clear an existing score to trigger rescoring and then set this status — the LLM scorer will write llmScore but NOT clear scoreStatus, leaving the review excluded from all subsequent rebuilds.

**How to apply:** After any LLM scoring run that scores a file which had scoreStatus=TO_BE_CALCULATED, manually set scoreStatus=SCORED in the file (or verify the scorer cleared it). If a review has an llmScore or humanReviewScore but still doesn't appear in the rebuild output, check scoreStatus first.
