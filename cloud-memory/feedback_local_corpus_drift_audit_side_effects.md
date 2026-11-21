---
name: feedback-local-corpus-drift-audit-side-effects
description: "running check-corpus-drift.js / its sub-audits locally regenerates data/audit/*.json snapshots and can touch data/outlet-registry.json — don't commit those, they race CI's authoritative regeneration"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 78b4125e-bc04-41fb-9f16-13baa4bf51b7
  modified: 2026-08-10T11:51:43.178Z
---

Running any of the 17 [[project_coverage_verdict_plan|corpus-drift]] sub-audits locally (e.g. `node scripts/check-corpus-drift.js`, `node scripts/audit-non-reviews.js`) rewrites its `data/audit/*.json` output file in the working tree as a side effect — these are declared `merge=ours` in `.gitattributes` specifically because `check-corpus-drift.yml` commits a fresh one after every CI run. A stale local snapshot committed alongside a real fix races that authoritative regeneration and can misreport drift counts for up to a day.

**Why:** discovered task #1213 (2026-08-10) — `git status` after running several audit scripts to verify a fix showed `data/audit/churn-merge-coverage.json` and `data/audit/non-review-audit.json` modified, neither part of the intended change. Also saw a separately-dirty `data/outlet-registry.json` at session start with no local script writing to it (pre-existing uncommitted state from another process, unrelated to the task at hand).

**How to apply:** before `git add`/`git commit` after running any corpus-drift audit locally for verification, `git status --short` and `git restore` any `data/audit/*.json` / `data/outlet-registry.json` diffs that weren't part of the deliberate fix. Only commit files you intentionally edited (the script/config change itself, or a data file you ran with an explicit `--write`/`--fix` flag).
