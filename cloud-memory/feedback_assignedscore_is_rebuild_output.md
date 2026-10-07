---
name: assignedScore is rebuild OUTPUT, not source-of-truth on per-file JSON
description: assignedScore lives in reviews.json (the derived file), NOT on per-file data/review-texts JSON. Audit predicates that read per-file JSON must check the source-of-truth fields rebuild reads, in precedence order. Caught 2026-04-28 ship-check P0.
type: feedback
originSessionId: 4a88f5bf-d40d-4933-882a-0b534879c331
archived: true
---
**Rule:** When auditing whether a per-file review JSON is "scored," NEVER check `data.assignedScore`. That field is the OUTPUT of rebuild's `getBestScore()` and lives in `reviews.json` (the derived file), not on `data/review-texts/{showId}/*.json`.

**Why:** rebuild-helpers.js getBestScore reads source-of-truth fields in precedence order:
- P0: `humanReviewScore` (non-provisional only — `humanReviewScoreProvisional===true` SKIPS this!)
- P0a: `adjudicatedScore`
- P0.5: `originalScore` + `originalScoreNormalized` (respects `originalScoreCleared`)
- P1: `llmScore.score`

It writes the chosen value to `assignedScore` in the rebuilt reviews.json. The per-file JSON is the input; reviews.json is the output. They live in different files.

**How to apply:** Any audit script reading `data/review-texts/{showId}/*.json` and checking "is this scored?" must check those 4 source-of-truth fields, in order, with the provisional + cleared respected. Use `verify-all-scored.js`'s `hasValidScore()` (lines ~155-180) as the reference implementation.

**Caught:** 2026-04-28 round-1 ship-check on `verify-all-scored.js`. 5 false-positive Beaches "orphans" (Chris Jones, Joshua Hayes, Dave Quinn, Dan Rubins, Zachary Stewart) flagged because the original predicate checked `assignedScore` on per-file JSON where it's always undefined. The files all had `llmScore.score` set; rebuild correctly scored them. Predicate fix: read the four precedence fields in order.

**Generalization:** This is the same shape as the recurring "rebuild-output vs source-of-truth" confusion. Other rebuild-output fields that don't belong on per-file JSON: `bucket`, `thumb`, `assignedTier`, `displayedScore`. If a script is reading these from a per-file JSON, suspect the same bug.
