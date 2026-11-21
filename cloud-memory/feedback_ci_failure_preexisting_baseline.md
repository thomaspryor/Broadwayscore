---
name: Check main's CI baseline before treating a PR red check as a regression
description: Before blocking on a failing PR check, verify whether main's most recent run of the same check also failed. Pre-existing failures are not regressions from your PR.
type: feedback
originSessionId: 0c5a9a9a-3a8a-4631-9870-3de8d2120302
---
Before treating a failing CI check on your PR as a blocker, check whether main's most recent run of the same workflow/job is ALSO failing. Pre-existing main-branch failures mean your PR isn't introducing the problem.

**Why:** 2026-04-22 ship-check on PR #263 showed Data Validation failing with 36 strict contamination issues (audit-review-contamination.js). Initial instinct was to block the merge — but a quick `gh run list --branch main --workflow="Test Suite" --limit 5` showed main was already failing with 39 strict issues on the preceding run. The PR wasn't causing the problem — it was an ongoing data-quality drift in the private data repo, unrelated to the code in PR #263. Blocking would have held up Bug #11/#12 fixes for no reason.

**How to apply:**
- When `gh pr checks` shows a red check, run `gh run list --branch main --workflow="<same workflow>" --limit 3 --json conclusion,headSha` to see main's baseline.
- If main is red too and your PR doesn't touch the failing job's inputs, the failure is not a PR regression — file a separate card and merge.
- If main is green and your PR is red, you've introduced the regression — fix before merge.
- Exception: if your PR modifies the workflow's inputs (data files, scripts the job runs), treat any red as possibly yours regardless of main's state.

Related: `feedback_ci_sequential_gates_mask.md` (one failing gate masks downstream gates within a single run); this feedback is about failures ACROSS runs on main vs PR.
