# BRO-5673 verification

VERIFY: `node --test scripts/batch-session-optimization.test.mjs`

The older `node --test scripts/verify-bro-5384-codex-throughput.test.mjs`
command is an alias for the same offline suite. Neither command measures
current live throughput or proves that every part of this card is complete.

The acceptance suite imports existing tests of production helpers and callers:

* `scripts/lib/cloud-worker-pick.test.mjs`: leave suitable cards to Codex up to
  its capacity; keep urgent, START-NOW, resumed and unsuitable cards available
  to the Claude lane; reclaim paused and machine-parked cards safely.
* `tests/unit/session-model.test.mjs`: use Sonnet for mixed batches rather than
  spending an entire Opus session on one retry; preserve explicit model policy.
* `tests/unit/codex-runner-stop-context.test.mjs`: bound cloud and GitHub card
  runs, validate time flags, and preserve landing time for explicit PR runs.
* `tests/unit/block-prompting-remote-tools.test.mjs`: run the actual session hook
  to require a valid BUDGET line. This is a prompt contract, not a process kill
  timer for remote Claude sessions.
* `tests/unit/land-retry-cancelled-schedule.test.mjs`: pin the 20-minute sweep and
  the hourly schedule strings used by the stranded and reclaim jobs.

## Review and scope

The card records a six-reviewer plan review and owner approval on 2026-10-19.
Its revised plan preserves the real landed-card closers, the stranded-ref
resumer, main-infra-rerun, and digest-autofix. The land fail-fast decision was
split into BRO-5719. No watcher deletion or filer shutdown is authorized by
the earlier estimate of 84 cards alone.

The smallest remaining code fix is to make acceptance runnable on main using
the tests that already exercise the behavior. New optimization logic, a dormant
policy table, and a second implementation of the existing tests are unnecessary.
CI already runs all imported suites individually. Both entry points are
acceptance shims, exempt from duplicate CI execution in
`scripts/audit-orphan-tests.js`. The batch entry point is also excluded by
`scripts/lib/unit-test-collection.js`, following its existing shim convention.

## Operational evidence still required

As of this worker's 2026-11-16 checkout, the available Linear issue snapshot is
dated 2026-08-26 and predates the 2026-10-16 `Filed by:` attribution rollout.
It cannot establish current per-source rates. Live Linear access is unavailable
(`LINEAR_API_KEY not set in .env or environment`). Do not disable any filer from
this snapshot or infer that zero candidates exist today.

Re-measure the approved 14-day per-filer close-by-land-commit rates with current
attributed cards. A source may switch to digest-only only below 25%, after its
digest row is confirmed to still queue the work. Digest-autofix stays enabled.
The 2026-10-19 zero-candidate cleanup result is historical evidence only.
Current throughput, the conditional filer decision, and the runner's landing
evidence remain necessary before closing the full card.

These acceptance commands make no paid fetches, LLM calls or service API calls.

## Worker validation

Both acceptance paths initially failed with `Could not find`, and
`git cat-file -e origin/main:<path>` confirmed both are absent on main.
`git log -S 'BUDGET:' --oneline -5 -- .claude/hooks/block-prompting-remote-tools.sh`
(also searched for `leaveCodexCards` and `*/20` in their production files)
returned snapshot commit `23383cb20`. Existing behavior tests passed before
this change: 108 tests, zero failures.

Comparing main's real collector with the changed collector on the same current
repository tree gives 2,282 versus 2,281 entries. The only removed entry is the
new batch acceptance shim, avoiding a second run of its imported suites. The
historical VERIFY alias remains uncollected, and
`tests/unit/session-model.test.mjs` remains collected. The audit gains exactly
the two shim exemptions. No unrelated test loses its execution path.

The production model policy was also replayed before and after on all 807
records in the available historical snapshot: 776 Sonnet, 31 Opus both times,
zero changed records. Cloud limits remain 105/112 minutes; the workflow's
explicit GitHub limits remain 210/290. No production data or automation is
modified by this patch.

Commands and results:

* `node --test scripts/batch-session-optimization.test.mjs`: 117 passed.
* `node --test scripts/verify-bro-5384-codex-throughput.test.mjs`: 117 passed.
* The combined acceptance and regression command below: 498 passed.
* The remaining collector regression command below: 43 passed.
* `node scripts/audit-orphan-tests.js`: all 2,638 tests registered.
* `node scripts/audit-toplevel-script-test-yml-coverage.js`: no gaps.
* `node scripts/audit-test-yml-lib-deps.js`: no gaps.
* `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  exit 0, `lint-workflows: all gates green`; read its `lint-workflows.log`.
  Actionlint was unavailable, so that check remains with CI.
* `git diff --check`: passed.

```sh
node --test --test-timeout 300000 scripts/batch-session-optimization.test.mjs scripts/verify-bro-5384-codex-throughput.test.mjs scripts/audit-orphan-tests.test.mjs scripts/lib/colocated-test-ci-coverage.test.mjs scripts/lib/autonomous-triage-core.test.mjs tests/unit/ci-manifest-no-dated-probes.test.mjs tests/unit/test-file-locations.test.mjs tests/unit/test-manifest-integrity.test.mjs tests/unit/land-preflight.test.mjs tests/unit/card-premises-auditor.test.mjs scripts/tests/trunk-status.test.mjs scripts/tests/enrich-card-acceptance-fallback.test.mjs tests/unit/autonomous-acceptance-recheck.test.mjs tests/unit/coverage-guard-wired.test.mjs tests/unit/glob-based-manifest.test.mjs scripts/lib/test-yml-manifest-paths.test.mjs
node --test --test-timeout 300000 scripts/audit-test-file-extensions.test.mjs tests/unit/check-corpus-drift.test.mjs tests/unit/live-data-lane.test.mjs tests/unit/git-race-fix.test.mjs
```
