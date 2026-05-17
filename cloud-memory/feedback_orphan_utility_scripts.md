---
name: Orphan utility scripts that should be wired into CI
description: Scripts in scripts/ that aren't called by any workflow or other script are dead code OR pending work. Before adding new flags/scripts, grep for existing utilities that already solve the problem.
type: feedback
originSessionId: b26e10ae-8a24-4c7d-baa4-a7f5408230cb
---
# Orphan utility scripts hide existing solutions

**Rule:** When approaching a data-quality / detection / classification problem, BEFORE writing new code, search for existing scripts that look related: `grep -rn "{problem-keyword}" scripts/ .github/workflows/`. If a script exists but no workflow or other script calls it, it's an **orphan** — likely written for the same problem but never wired in.

**Why:** Orphan utilities accumulate as "I'll wire this up later" code. Without CI integration, they never run, and the problem the script was meant to detect persists. Worse, a future session may write a near-duplicate solution because the orphan is invisible from the workflow inventory.

**How to apply:**
- Before writing a new detection/classification script, run `grep -rln "{concept}" scripts/`. If an existing script matches, READ it.
- If an existing script solves the problem but isn't called: wire it into the appropriate workflow OR delete it (don't leave orphans).
- When wiring a script into CI, also check: does the script SKIP the cases your problem cares about? (orphans often have stale skip-lists from when they were last useful).
- Audit: `for f in scripts/*.js scripts/*.ts; do n=$(basename "$f" .js); grep -rl "$n" .github/workflows scripts | grep -v "$f" >/dev/null || echo ORPHAN: $f; done`

**Origin:** Issue #316 NYer joint review. `scripts/flag-combined-reviews.js` (~year old) marks files `isCombinedReview:true` when a URL appears in 2+ show dirs — exactly the joint-review case. Was an orphan: no workflow called it, and it skipped `wrongShow:true` files (so couldn't recover the misclassified Lost Boys NYer file). Fixed by wiring into `opening-night-poller.yml`, removing the wrongShow skip, and adding a base-slug filter (commits 83ec10e984, 42746ab620).
