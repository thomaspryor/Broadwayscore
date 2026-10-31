---
name: cv-heuristic-fallback-cant-detect-wrongprod
description: "verifyContent's heuristic fallback always returns wrongProduction:false — auto-clear predicates must require verifiedBy startsWith('llm')"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5668bc17-77e4-483e-aa3d-86474bda00f9
  modified: 2026-07-20T01:14:30.771Z
---

`verifyContent()` (scripts/lib/content-verifier.js) falls back to `heuristicVerify` when every LLM provider errors or the response fails to parse — and the heuristic structurally CANNOT detect wrong productions, so it always returns `wrongProduction: false` (and can return `isValid: true`). During the 2026-07-19 era-venue reverification, 3 of 150 auto-clears were blessed by mid-run Haiku parse failures and had to be reverted post-audit.

**Why:** A predicate like `cv.isValid && !cv.wrongProduction` looks safe but silently passes on outage verdicts that never evaluated the question.

**How to apply:** Any script that clears an exclusion flag (wrongProduction, wrongShow, isNonReview…) based on a fresh CV verdict MUST gate on `typeof cv.verifiedBy === 'string' && cv.verifiedBy.startsWith('llm')` AND check the sibling blockers (`wrongArticle`, `isFilmTv`) — see scripts/reverify-era-venue-wrongprod.js for the reference predicate, and audit applied writes afterward (`verifiedBy` is stored in the written contentVerification block). Related: [[feedback_llm_verifier_hallucinates]].
