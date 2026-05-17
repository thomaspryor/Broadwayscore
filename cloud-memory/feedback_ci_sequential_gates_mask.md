---
name: CI sequential gates mask each other (set -e ordering)
description: "set -e skips downstream gates; run full job after fixing first failure."
type: feedback
originSessionId: 20ebcdcd-4641-4d32-8342-95738ea48cc1
archived: true
---
When a CI job's steps run sequentially under bash `set -e` (the default for `shell: /usr/bin/bash -e {0}` workflows), the FIRST failing step short-circuits the rest. This means downstream audit/quality steps don't run while an upstream step is broken. Pre-existing data debt accumulates invisibly behind the visible failure.

**Why:** 2026-04-15 — Test Suite had been failing 77/100 times. The visible error was `validate-data.js` (14 aggregator-score files). Once I fixed that, the next step `audit-review-contamination.js --strict` finally ran and surfaced 150+ pre-existing contamination hits across A_cross_market, B_false_positive_wp, C_domain_mismatch, F_empty_unknown classes. None of them were caused by the validate-data fix — they were always there, just hidden.

**How to apply:**
1. When fixing a CI step that's been failing for a while, IMMEDIATELY check what step runs AFTER it in the same job. That step is the next one to fail.
2. Run the FULL job locally (not just the failing step) BEFORE pushing — `gh workflow run` with the dispatch shows you the cascade.
3. If you find pre-existing audit failures behind your fix, decide whether to fix them in the same session (preferred — keeps CI green) or document them as separate Notion cards.
4. Look for the pattern: any workflow file using `shell: /usr/bin/bash -e {0}` and multiple `run: node scripts/...` audit steps in one job has this hazard. Consider splitting audit steps into separate jobs so one failing audit doesn't hide the others.

See: data-validation job in .github/workflows/test.yml — currently has 6+ audit steps in a single job.
