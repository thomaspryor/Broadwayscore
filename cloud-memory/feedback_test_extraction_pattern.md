---
name: Test extraction pattern for pipeline scripts
description: Rule — never copy logic into test files; extract pure functions to lib/ and require() them
type: feedback
---

Never copy logic into test files. Always `require()` the real production function.

**Why:** Tests that copy logic don't catch regressions — they just re-implement the same bug. When production code is updated, a copied test continues to pass even though the behavior diverged. `require()`-ing the real function means the test fails when production changes, which forces verification of the new behavior.

**How to apply:**
1. When fixing inline logic in a pipeline script, extract the pure decision function to `scripts/lib/review-guards.js` (or a new `scripts/lib/` file)
2. `module.exports` the function
3. Wire it back into the production file with `require('./lib/review-guards')`
4. In the test file, `require('./lib/review-guards')` and call the real function — no local copies

**Established pattern:** `scripts/lib/review-guards.js` exports `shouldSkipScoredReview`, `pickBestDtliSlug`, `applyTemporalOverrides` — all pure, no I/O, testable in isolation.

**CLAUDE.md rule §15** documents this for all sessions.
