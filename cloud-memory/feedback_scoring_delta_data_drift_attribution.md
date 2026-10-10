---
name: scoring-delta data-drift attribution gotcha
description: scoring-delta compares HEAD-tree vs working-tree predicates AND review-text disk state. Parallel cron commits to data/review-texts during your session show up as flips even when your code change is responsible for none of them. Read the "Phase A: code diff" line and the t1Details fields to attribute correctly.
type: feedback
originSessionId: f1921624-1ffa-49ff-90ec-f2a28fd6940d
archived: true
---
scripts/scoring-delta.js compares two things at once:
- **Code:** isIncludableForRebuild between HEAD and working-tree
- **Data:** review-text JSON files on disk

The output reports total flips without distinguishing which axis caused each one. **If a parallel cron clears wrongProduction on a file between your two snapshots, that flip shows up as if your code did it.**

**Why:** The script writes to `data/audit/llm-scoring-parity-baseline.json` and reads review-texts via the symlinked submodule. The submodule advances independently of your branch.

**How to apply:**
1. Read the `Phase A:` line in the output:
   - `no code diff, N flag-field changes` → ALL flips are data drift, your code is scoring-neutral.
   - `code diff detected, N flag-field changes` → flips are mixed; attribution requires deeper inspection.
2. If code diff detected and a T1 flip lands, run `--json` and read `t1Details[].baselineReason` vs `workingReason`. If the transition is `wrongProduction → manually cleared`, it's almost always a data-drift cron, not your code (your code change rarely flips manual-clear flags).
3. Spot-check the file on disk: `node -e "const d=require('./data/review-texts/SHOW/FILE.json'); console.log(d.wrongProduction, d.wrongProductionManualClear)"` — if neither flag matches the baseline state, parallel cron got there first.

**Origin:** 2026-04-29 Card A (predicate-drift parity refactor, Notion 34f637c5-416f-810d). scoring-delta reported 1 T1 inclusion flip on `that-championship-season-1972/hollywood-reporter--david-rooney.json`. Spot-check showed the file had no `wrongProduction` flag at working-tree time — a parallel audit cron had cleared it. The flip was real but not attributable to my is-scoreable refactor.

**Don't apply when:** your edit touches review-guards.js or rebuild-helpers.js scoring logic — those CAN cause the flips reported. Only dismiss as drift when the predicate change is in a sibling file (is-scoreable.js, audit-llm-scoring-parity.js) and the t1Details transition matches a typical cron-pattern (manual-clear flips).
