---
name: Refactor parity test — old vs new on real data
description: Rule — before shipping a refactor that moves logic from inline to a shared lib, run BOTH versions side-by-side on real data and diff the outputs. 0 diffs = safe ship.
type: feedback
originSessionId: 3548d82c-4d8f-4ce3-8b16-044161f84602
---
When refactoring inline logic into a shared lib, unit tests prove the new function handles the cases you thought of. A parity diff against real data proves it matches the old function on the cases you didn't think of.

**Why:** 2026-04-22, I extracted `validate-data.js`'s silent-gap skip logic into `scripts/lib/review-text-scoreable.js`. Unit tests covered ~20 individual flag cases. But the real data has 36,355 review-text files with hundreds of combinations of those flags — some of which my unit tests never exercised. To ship safely, I wrote a standalone script that ran BOTH the original inline predicate AND the refactored lib predicate against every file and counted diffs. Result: **0 diffs across 36,355 files**. That gave me high confidence to ship the refactor; the lib is behaviorally identical to the inline version it replaced.

**How to apply:**

For any refactor that extracts inline logic into a pure function:

1. Keep a copy of the original inline logic in a scratch file (paste from `git show HEAD:<path>`).
2. Write a one-off `node -e` or standalone script that:
   - Iterates every real record the production code touches
   - Runs the ORIGINAL inline predicate
   - Runs the NEW lib predicate
   - Counts where they disagree
   - Dumps 5 sample diffs
3. Target 0 diffs. If the diff is non-zero, either (a) the refactor has a bug, or (b) you INTENDED to change behavior — in which case the commit message should say so explicitly.
4. Commit the parity-test result (either in the PR description or as a scratch artifact) so future reviewers can see you checked.

**Pattern example (2026-04-22):**
```js
function originalSilentGap(r) { /* paste of old inline logic */ }
function refactoredSilentGap(r) { return passesFlagFilters(r) && !hasValidScore(r); }

let diffs = 0;
for (const f of allReviewFiles) {
  const data = JSON.parse(fs.readFileSync(f));
  if (originalSilentGap(data) !== refactoredSilentGap(data)) diffs++;
}
console.log('diffs:', diffs);  // expect 0
```

**When you CAN skip parity testing:** when the refactor is purely cosmetic (rename, whitespace, move file) with no logic change. When in doubt, run the test — it's 2 minutes and it would have caught the one bug I worried about.

**Related:** `feedback_test_extraction_pattern.md` is about tests require()-ing the real function (CLAUDE.md §15). This rule is complementary — parity testing checks the extraction itself BEFORE unit tests start passing.
