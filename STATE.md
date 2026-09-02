# STATE — headless crown successor (BRO-343 v28), 2026-09-02

Branch `job/crown-BRO-343-v28-headless-mtkh6o0f`. **Everything below is merged on
main `a88ac225d2a` and CI-verified green job-by-job. Nothing is in flight.**

## Done

1. **Priority (a) — CI green on main, job-by-job.**
   - Run 33671213226 on `7e73f562483` (the state I inherited): `success`, 7 success / 3
     skipped. The 3 skipped are Dependency Audit, Visual Regression, Awards Data Freshness,
     gated on `event_name == 'schedule' || 'workflow_dispatch'` — skipped by design on a push.
   - Run 33674821020 on `a88ac225d2a` (my own merge): `success`, same 7/3 split.

2. **Priority (b) — safe-form allowlist. Already shipped; re-verified, and CLOSED OUT.**
   14/14 tests pass, scanner exits 0 with the 39 claimed names, the 300-card sample still
   reads armed 145 / refused 155 / basename 5. **New**: all five residual basename refusals
   are correct — the fifth (`audit-unknown-outlets.js`, BRO-2725) is refused because its
   require graph reaches `scripts/lib/url-discovery.js` → scraper/axios/fetch. There is no
   further legitimate widening. Recorded on BRO-2718 ("P0: 253/300 sampled open Linear issues
   (84%) are undispatchable"). The remaining blocker is card content: 113 of 155 refusals are
   prose-only acceptance criteria.

3. **BRO-2748 ("P2: containment guard in show-image-presence.js survives a mutation") — DONE.**
   Added the injected-fs assertion. Mutation-verified: removing `+ path.sep` makes the new
   test the only one of 10 that fails; restored, 10/10 pass.

4. **BRO-2750 ("P1: scripts/lib/title-match.test.js ran in ZERO CI jobs") — filed, fixed.**
   `scripts/lib/title-match.test.js` is CommonJS, so `.test.js`, so test.yml:3639's
   `tests=(scripts/lib/*.test.mjs)` glob never matched it; it was in none of the three
   manifests and named in no workflow. `audit-orphan-tests.js:47` excludes scripts/lib/ and is
   glob-blind, so both guards read all-clear. Registered it, and added
   `scripts/lib/colocated-test-ci-coverage.test.mjs` (runs inside the glob, so it polices the
   mechanism that runs it). Seven-case mutation battery, all correct.

## Corrections to the v28 handoff — do not re-derive these

- **`evaluateInfraReviewGate` does NOT disagree with CLAUDE.md's prose.** v28's "reports
  linear-dispatch.js, bsc-runner.js, claude-cli.js and pii-scan.js all as gated:false" came
  from calling it with `{files:[...]}`. The parameter is **`paths`** (infra-review-scope.js:657),
  and it also needs `repoRoot`. Called correctly, `.github/workflows/test.yml` → **block /
  critical**, `scripts/lib/pii-scan.js` and `autonomous-triage-core.js` → warn / shared.
  (bsc-runner.js and linear-dispatch.js genuinely do report gated:false.)
- **`~/broadway-review-texts` is a STALE second clone** — last commit 2026-08-26, with
  uncommitted deletions. The live review-texts repo is checked out at
  `~/Broadwayscore/data/review-texts` (commit from today). Running a crown gate against the
  stale clone produces a phantom red (`the-washington-post` missing from the registry). Against
  the live corpus all three gates exit 0.
- **A fresh worktree has no `node_modules`** on top of the documented missing gitignored data;
  symlink it from the main checkout or nothing requiring a dep will run.

## Remaining / next

- BRO-2740 (156 orphaned wrongProduction provenance files) — untouched by design, root cause
  still pinpointed in v28 §2.
- BRO-2741 (headless jobs report done while work is killed) — detection still reverted; the
  65-log labelled dataset is on the card.
- Backlog depth: 90 of the 100 open P0/P1 issues pass the dual-predicate funnel
  (armed + dispatchable). Nothing was dispatched this session — a headless session cannot
  monitor a fan-out to completion, and cmux is still at its terminal ceiling.
- Residual on BRO-2750: the guard accepts an executed glob in ANY workflow, while its error
  text names test.yml specifically. `_skip-` is inert inside scripts/lib (the shell glob runs
  those files anyway). Both are false-RED-direction, neither is live.

## Exact next command

    node /tmp/linear-p1.js     # (recreate: dual-predicate funnel over live Linear P0/P1)

or resume the crown cycle from the v28 prompt at
`~/Documents/claude-outputs/HANDOFF-crown-v28-2026-09-02.md`.
