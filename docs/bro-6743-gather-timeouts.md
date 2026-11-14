# BRO-6743: gather timeout investigation

Status: partial. The missing acceptance test now exists. No production code or
workflow was changed, and the card's timeout recovery criteria are not complete.

## Current behavior and reproduction

The starting checkout and `origin/main` both point to
`c19b39c4461aa6ebed04ae0e9dcdd5b41e3c5566`. On that checkout,
`node --test scripts/lib/gather-deferred.test.mjs` failed with
`Could not find 'scripts/lib/gather-deferred.test.mjs'`.

The suggested checkpoint fix already exists:

- `scripts/gather-reviews.js:6197` records every eligible show before the loop.
- Lines 6202 and 6221 rewrite the remainder on budget exhaustion and after each
  attempted show, respectively.
- `.github/workflows/gather-reviews.yml:541` uploads that file with `if: always()`.
- Lines 1101-1108 collect uploaded files and call `redispatchPlan`. They do not
  reconcile assigned shows against completion evidence.

The incident commit, `5ca861a44851483015cbe943730660ec1148862f`, also has the three
checkpoint calls (lines 6205, 6210, 6229). Adding a SIGTERM handler that writes the
same remainder would duplicate existing behavior and would not establish the
cause of the incident.

Using IDs verified in the supplied `data/shows.json`, both the main helper and
the unchanged working-tree helper produce these results:

| State | Checkpoint / next hop |
| --- | --- |
| None finished | All three retained; `stalled: true` prevents an endless retry |
| Building the Wall finished | `the-lost-boys-2026`, `hadestown-west-end-2024` retained and re-dispatched |
| All finished | Empty checkpoint and empty hop |

The first ID is `building-the-wall-off-broadway-2017`. Before/after comparison:
0 of 3 cases changed; 0 data records modified. If the same partial run supplies
no artifact contents, `redispatchPlan([], runShows)` returns an empty hop with
`stalled: false`. This reproduces the missing-artifact blind spot, but does not
prove that the incident lost its artifact.

The new test file calls the real library. It tests SIGTERM and SIGKILL after
three checkpoint states, merging partial shard lists, clearing completed work,
and the no-progress guard. It does not run the gather loop or GitHub Actions,
and passing it does not establish reliable timeout recovery.

## Cancellation classification

Read-only GitHub REST audit on 2026-11-01: the latest 60 runs span
2026-10-30T04:21:37Z through 2026-11-01T00:33:28Z. This is a newer sample than the
card's 26 cancellations. It contains 31 successful runs and 29 cancelled runs:

| Classification | Runs | Evidence |
| --- | ---: | --- |
| Shard exceeded its 75-minute timeout | 3 | Check-run maximum-execution-time annotation |
| Explicit manual cancellation while waiting for a gather slot | 5 | Prepare job's explicit run-cancel annotation; downstream jobs never ran |
| Rebuild concurrency eviction only | 21 | Rebuild annotation says a higher-priority waiting request exists; no cancelled gather shard |

One timeout run also had a rebuild eviction. The categories above count each
run once, giving precedence to a real shard timeout.

| Timeout run / job | Job minutes | Interrupted step | Gather / deferred upload / follow-up |
| --- | ---: | --- | --- |
| [41122444236 / 124300836280](https://github.com/thomaspryor/Broadwayscore/actions/runs/41122444236/job/124300836280) | 77.67 | Gather reviews | cancelled / success / success |
| [41177702924 / 124470868010](https://github.com/thomaspryor/Broadwayscore/actions/runs/41177702924/job/124470868010) | 75.32 | Commit scraper-spend ledger | success / success / success |
| [41094755704 / 124229966455](https://github.com/thomaspryor/Broadwayscore/actions/runs/41094755704/job/124229966455) | 77.57 | Push aggregator-archive to private repo | success / success / success |

Only the first timeout interrupted gathering. The other two do not by
themselves establish unfinished shows. Successful artifact-upload steps are
also not proof of a populated artifact because `if-no-files-found: ignore` is
configured. The incident's artifact listing now has `total_count: 0`; retention
is one day, so its historical contents cannot be determined from that listing.

Manual cancellation run IDs: 41103247976, 41103187413, 41103124417, 41103058167,
41103000506.

Rebuild-only cancellation run IDs: 41257258070, 41249754748, 41248939982,
41243392031, 41242619324, 41241244719, 41226309934, 41218776891, 41218774809,
41217569841, 41215693374, 41214799090, 41210116443, 41205464146, 41184458517,
41183275489, 41144998632, 41089861036, 41089853693, 41018849529, 41002452415.

Sources queried, all GETs against `https://api.github.com`:

```text
/repos/thomaspryor/Broadwayscore/actions/workflows/gather-reviews.yml/runs?per_page=60
/repos/thomaspryor/Broadwayscore/actions/runs/{run_id}/jobs?per_page=100
/repos/thomaspryor/Broadwayscore/check-runs/{job_id}/annotations
/repos/thomaspryor/Broadwayscore/actions/runs/41122444236/artifacts?per_page=100
```

The incident script was read from `raw.githubusercontent.com` at the incident
commit above. The audit made 66 GitHub API GETs and one raw-source GET. These
are one-off investigation reads, not new scheduled requests. This change adds
zero production API calls, paid fetches, or LLM calls.

## Verification and remaining work

- `node --test scripts/lib/gather-deferred.test.mjs`: 8 passed, 0 failed.
- `node --test --test-timeout 300000 scripts/lib/gather-deferred.test.mjs tests/unit/gather-queue-eviction.test.mjs`:
  20 passed, 0 failed. The existing queue suite checks workflow wiring.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  exit 1 solely because `actionlint` is missing; all other invoked audits passed.
- `git log -S 'recordDeferredShows' --oneline -5` could not complete because
  missing partial-clone objects require fetching into the read-only Git object
  store. Reading the current main and incident versions succeeded.
- CI already runs `scripts/lib/*.test.mjs`; no test manifest change is needed.

Remaining: establish which incident show attempts completed and what the
follow-up actually received. Then add the assigned-minus-finished pure helper
and workflow reconciliation, preserving lease exclusions, attempt isolation,
intentional cancellation behavior, and a bounded no-progress policy. The
worker was explicitly prohibited from editing `.github/workflows/**`, so no
unused helper or speculative production patch was added here.
