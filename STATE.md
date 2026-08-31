# BRO-2597 — state as of this session's time-budget cutoff

## Done
- Root cause found and fixed: `scripts/lib/push-with-retry.stranded-commit-cascade.test.sh`'s
  fixture clone (`git clone -q "file://$TMP/origin.git" "$TMP/runner"`) relied on the bare
  origin's implicit HEAD to pick a branch. HEAD is set from `init.defaultBranch` at bare-init
  time and never updated after the seed pushed "main" — on hosts where the default differs
  (CI), the clone checks out nothing, matching the exact reported failure.
- Fix: pinned `--branch main` on the clone + added a fail-loud assertion right after cloning.
  Reproduced the CI failure locally via `git config --global init.defaultBranch master`,
  confirmed the fix resolves it, then reverted the global config.
- `/second-opinion` run BEFORE first edit (CLAUDE.md rule 18, shared-infra scope). Both plan
  and implementation verdicts recorded in `.claude/review-verdicts.jsonl`.
- `/what-else` found 2 real cousins with the identical dangling-HEAD clone pattern (not
  CI-wired, dev-time-only tools, so they didn't cause the P0, but would silently misbehave on
  a differently-configured host): `scripts/lib/push-mutex.race-test.sh:45` and
  `scripts/lib/test-sync-check.sh:63,98`. Fixed both the same way. `test-sync-check.sh`
  verified 11/11 pass. `push-mutex.race-test.sh` run was killed (exit 137) by the session's
  own 10-min hard-kill / background-task teardown, NOT a regression — it's an unrelated
  pre-existing slow race test (two pushers with sleeps + retry backoff), not touched
  substantively by the fix (only the clone line changed). Re-run it standalone before trusting
  it fully: `timeout 60 bash scripts/lib/push-mutex.race-test.sh`.
- PR #769 opened, all its own CI checks passed (TypeScript, Lint, Design Token, **Unit Tests
  pass @ 8m20s**, E2E), then merged to main via `gh pr merge 769 --merge --auto` →
  merge commit `afad543aeb1` on origin/main.
- Linear BRO-2597 updated to `in-review` mid-session with full summary (before the cousin-fix
  commit landed).

## NOT yet done — this is the one remaining acceptance-criteria step
- **Confirm `Unit Tests` is green on the post-merge run on `main`** (not just the PR's own
  run — the issue explicitly requires the main-branch confirmation, not just a passing PR).
  A new run was queued for merge commit `afad543aeb18b1a563eee03965d1f0fa5d29de20`:
  run id `33396778294`, status was `in_progress` at cutoff.
  Next command: `gh run view 33396778294 --json status,conclusion,jobs`
  (or `gh run list --branch main --workflow=test.yml --limit=1`)
- Once confirmed green, report to Linear as done:
  ```
  node scripts/linear-session.js report --issue=BRO-2597 --status=done \
    --summary="Fixed dangling-HEAD fixture clone bug in push-with-retry.stranded-commit-cascade.test.sh (pinned --branch main + fail-loud assertion) plus 2 cousins found via /what-else (push-mutex.race-test.sh, test-sync-check.sh). PR #769 merged to main (afad543aeb1). Confirmed Unit Tests green on main post-merge run <RUN_ID>." \
    --key-files="scripts/lib/push-with-retry.stranded-commit-cascade.test.sh,scripts/lib/push-mutex.race-test.sh,scripts/lib/test-sync-check.sh" \
    --verification="gh run view <RUN_ID> --json conclusion (Unit Tests job = success) on main post-merge"
  ```
- If the main run turns out RED (unlikely — PR's own run of the exact same tree state
  passed), investigate immediately; do not just re-report done.
- After Linear is updated to done, run `/wrap-up` to close out cleanly (not yet run this
  session — deferred for the CI-confirmation step above).

## Worktree state
- Branch `job/linear-BRO-2597-mth8w89h` is fully pushed and merged into main. No uncommitted
  changes. Safe to remove worktree AFTER the main-CI-confirmation step above is done and
  Linear is marked done (or if abandoning, at least confirm main's CI first — that's the
  actual point of this ticket).
