# BRO-5673 verification

VERIFY: `node --test scripts/batch-session-optimization.test.mjs`

`node --test scripts/batch-session-optimization.test.mjs` replaces the stale
throughput command as BRO-5673's check. It verifies offline behavior only;
current live throughput and completion of the full card require separate evidence.

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
CI already runs all imported suites individually. The batch entry point is an
acceptance shim, exempt from duplicate CI execution in
`scripts/audit-orphan-tests.js`. The batch entry point is also excluded by
`scripts/lib/unit-test-collection.js`, following its existing shim convention.

## Operational evidence still required

This unattended worker must not access Linear. Local historical snapshots
cannot establish current per-source rates. Do not disable any filer from a
historical snapshot or infer that zero candidates exist today.

Re-measure the approved 14-day per-filer close-by-land-commit rates with current
attributed cards. A source may switch to digest-only only below 25%, after its
digest row is confirmed to still queue the work. Digest-autofix stays enabled.
The 2026-10-19 zero-candidate cleanup result is historical evidence only.
Current throughput, the conditional filer decision, and the runner's landing
evidence remain necessary before closing the full card.

This acceptance command makes no paid fetches, LLM calls or service API calls.

## Worker validation

The carried throughput alias passed 117 offline tests without measuring
throughput. It has been deleted along with its never-CI exemption. Running
`node --test scripts/verify-bro-5384-codex-throughput.test.mjs` now exits 1 with
`Could not find`. This prevents a misleading pass for BRO-5485, which also
names that file (`docs/audits/bro-7394-verify-path-triage.md:92`).

`git cat-file -e origin/main:<path>` confirms that both acceptance filenames
are absent on main. `git log -S 'verify-bro-5384-codex-throughput.test.mjs'
--oneline -5 -- scripts/audit-orphan-tests.js
scripts/verify-bro-5384-codex-throughput.test.mjs` identifies the carried
BRO-5673 attempt as the alias's source. The existing batch suite exercises
production behavior; no routing, budget, filer or watcher logic changes here.

Running `node scripts/audit-orphan-tests.js --json` on the real repository
before and after this correction gives 2,641 versus 2,640 test files, with
2,592 registered in both and zero orphans. Exactly one exemption record is
removed, for the deleted alias. The batch shim and the live OAuth probe remain
exempt, and every other audit field is identical.

Commands and results:

* `node --test scripts/batch-session-optimization.test.mjs`: 117 passed.
* The related regression command below: 296 passed.
* `node scripts/audit-orphan-tests.js --json`: no orphans or manifest problems.
* `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  exit 0, `lint-workflows: all gates green`; read `lint-workflows.log`.
  Actionlint is unavailable here and remains a CI check.
* `git diff --check`: passed.

```sh
node --test --test-timeout 300000 scripts/audit-orphan-tests.test.mjs scripts/lib/colocated-test-ci-coverage.test.mjs scripts/lib/autonomous-triage-core.test.mjs tests/unit/ci-manifest-no-dated-probes.test.mjs tests/unit/test-file-locations.test.mjs tests/unit/test-manifest-integrity.test.mjs tests/unit/land-preflight.test.mjs tests/unit/card-premises-auditor.test.mjs scripts/tests/trunk-status.test.mjs scripts/tests/enrich-card-acceptance-fallback.test.mjs tests/unit/autonomous-acceptance-recheck.test.mjs tests/unit/coverage-guard-wired.test.mjs tests/unit/owner-judgment-limbo-guard.test.mjs tests/unit/recheck-comment-rank.test.mjs tests/unit/glob-based-manifest.test.mjs scripts/lib/test-yml-manifest-paths.test.mjs
```
