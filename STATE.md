# STATE — headless crown successor (BRO-343 v28), 2026-09-02

Branch: `job/crown-BRO-343-v28-headless-mtkprngr`. Everything below is MERGED to main
and confirmed on origin (`git merge-base --is-ancestor <sha> origin/main` for each).

## DONE

### Priority (a) — CI on main, job-by-job
- Run 33697401511 on my merge commit `931f050f2cd` came back **failure**. Job-by-job:
  TypeScript Check / Lint Workflows / E2E Tests / **Unit Tests** / Design Token Drift Guard
  all `success`; Dependency Audit, Visual Regression, Awards Data Freshness `skipped`
  (gated on `event_name == 'schedule' || 'workflow_dispatch'` — by design on a push);
  **Data Validation `failure`**, Test Summary `failure` (it just mirrors).
- Data Validation's failing step was "Audit cast-changes.json":
  `GATE: 0 cross-show conflict(s) (zero-tolerance) + 25 total issue(s) vs floor 15`.
  Not a code regression — see BRO-2752 below. Fixed and merged (`37e3244d6ee`).
- **Unit Tests passing on that run is the acceptance signal for the BRO-2751 work below**
  (the two newly-registered bash tests run in that job).

### Priority (b) — safe-form allowlist / BRO-2718
Already landed before I picked up (commit `602a1f0d5a6`, 3 -> 39 entries). Re-derived
rather than trusted:
- `node scripts/audit-safe-form-allowlist.js` exit 0; `node --test scripts/lib/safe-form-allowlist.test.mjs` 14/14.
- `data/audit/card-verifiability-linear.json`: total 300, armed 145, refused 155 (51.7%),
  byKind `{no-command: 89, no-section: 24, shape: 37, basename: 5}`.
- **The allowlist is no longer the blocker.** `basename` is 5 of 155. The dominant refusal
  is `no-command` (89) — cards whose acceptance criteria are prose only. Further widening
  buys almost nothing; the remaining work on BRO-2718 is card CONTENT (enrichment), not
  the allowlist. `audit-outlet-registry.js --strict` staying refused is still correct
  (it calls `saveAuditResults()` unconditionally at line 948, writing a git-tracked file).

### Priority (c) — P1s drained
- **BRO-2751 — CLOSED (Done).** The card was parked as "needs an interactive session".
  It did not: rule 18 needs a recorded PLAN verdict, and a headless session can run
  /second-opinion and record it itself. Recorded `second-opinion / pass / restructure-flag: adopted`.
  Shipped in `9dc90907c39` + `9300070bd39`. Full outcome is on the Linear issue.
  The card's "pure gain, no red-CI risk" claim was WRONG and review caught it:
  `disk-floor-check.test.sh` FAILS under a runner's ambient `GITHUB_ACTIONS=true`
  (`ensure_disk_floor` returns 0 immediately, disk-floor-check.sh:17) — cases 1 and 4
  failed, 2 and 5 passed vacuously. Registering it as-is would have reddened main.
- **BRO-2748 — verified already Done, no work needed.** Mutated the containment check to
  `startsWith(publicDir)` without `path.sep` on a scratch copy: a test named
  "a public/-PREFIXED SIBLING directory is outside containment (BRO-2748)" catches it.
  Restored; suite 10/10; tree clean.
- **BRO-2322 — evidence attached, not fixed.** Diagnosed the recurring
  "Rebuild Reviews (Fast)" red (4 of last 8 runs): `PUSH_DEADLINE_SEC=600` funds ~5
  attempts at ~100s/cycle under contention, while the caller advertises `MAX_RETRIES=20`
  — a 4x disagreement — and the Git Data API fallback is disqualified by construction on
  this workflow because its whole output IS reviews.json. Left for that audit card
  because it is shared push infra (rule 18) and needs per-caller resizing, not a bump.
- **BRO-2752 — FILED (parked).** See below.
- **BRO-2432 — deliberately left alone.** Its own park reason says a live parallel session
  owns `scripts/clear-stale-wrong-show-flags.js`; dispatching would race it.

## THE ONE THING STILL OPEN

`gh workflow run test.yml --ref main` -> run **33698960075**, dispatched 00:19 UTC to
confirm Data Validation is green on the healed main. It was dispatched, not push-triggered,
because `data/cast-changes.json` is NOT in test.yml's push `paths:` — so the heal commit
alone cannot re-run the job that was red.

Exact next command:

    bash scripts/lib/wait-for-run.sh 33698960075 18
    gh run view 33698960075 --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'

Expect Data Validation `success`. NOTE: on a `workflow_dispatch` the three normally-skipped
jobs (Dependency Audit, Visual Regression, Awards Data Freshness) DO run and have not run on
a push in a long time — if one of them is red, that is not a push-CI regression and not
caused by anything in this session; judge main's health on the other seven jobs.

Already proven independently, so the run is confirmation rather than the only evidence:
`git show origin/main:data/cast-changes.json` is byte-identical to the local file, and
`node scripts/audit-cast-changes.js --gate` exits **0** against it
("0 cross-show conflicts, 0 issue(s) <= floor 15"). AUTO-FLAGGED count 315 -> 290.

## BRO-2752 — the real finding, filed and parked

`audit-cast-changes.js:180` drops `[AUTO-FLAGGED]` entries older than 30 days. All 25 that
reddened main shared `addedDate: "2026-08-04"`, so they crossed that threshold in the same
instant, at UTC midnight. `check-corpus-drift.yml:73-91` runs the correct remedy but only
daily — it ran at 19:45 UTC and correctly changed nothing (they were 29 days old then;
verified: commit `2aad9d9f8d8` moved the AUTO-FLAGGED count 315 -> 315). The gate runs on
every push. So the gate and the healer disagree about what time it is, and the gate runs
~50x more often. This is a step function, not the "routine churn" test.yml:4345-4359
describes as tolerable: any single day's batch larger than the floor of 15 guarantees a red
trunk until the next heal. Recommendation on the card is option A — `--gate` should not
count issues its own `--write` would auto-fix — plus a test asserting N auto-healable-only
issues never fail `--gate` for any N.

## Cycle state at handoff

`behind 0 / unpushed 0` at last check. 36 worktrees (31 at v28 handoff).
Disk **13Gi** free on `/System/Volumes/Data` (16-17Gi at v28 handoff) — watch the trend.
Dispatch ledger 11,588 rows, `runaway:0 future:0`.

Crown gates: `merge-reviews-json` keyOf tripwire 28/28 pass.
`audit-outlet-registry.js --strict` and `audit-critic-outlets.js --strict` could NOT run
here — this fresh worktree has an EMPTY `data/review-texts`, and both gates correctly
refuse to pass vacuously ("scanned 0 review files"). Environmental, not a failure; they
run for real in CI.

## Owner decisions — still open, untouched (a headless session cannot decide them)

1. iOS overnight worktrees (`~/BroadwayScorecard-app`, Aug 31 + Sep 1 `feedback-overnight`):
   review+merge vs confirmed discard. Each holds ONE real unmerged commit of TestFlight
   beta-feedback fixes. Standing recommendation: review+merge.
2. Forbes / Marc Hershberg walkthrough date. Standing recommendation: mid-to-late October,
   ahead of a Nov 1 publish rather than depending on it.

Not a decision, already made, execution blocked on the owner: Cyrus Team Cloud $120/mo
cancellation needs a hand on an external dashboard; no CLI/API path exists on this machine.

## Deliberately NOT done

No CronCreate. The v28 brief's crown loop assumes an interactive session that outlives its
cron; this one is hard-killed at 120 minutes, so a `13,43 * * * *` cron would only have
fired inside my own turn and duplicated work in flight.
