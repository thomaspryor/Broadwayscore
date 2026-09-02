# STATE — headless crown successor #2 (BRO-343 v28), 2026-09-02 22:10Z

Branch `job/crown-BRO-343-v28-headless-mtkmjryy`, **merged into main as `5ca25050a9e`
and verified on origin** (3/3 files content-survival checked). Nothing in flight except
the CI run named below.

## Done — and independently re-verified, not taken from the predecessor's STATE.md

1. **Priority (a) — CI green on main, job-by-job. CONFIRMED.**
   Run 33674821020 on `a88ac225d2a`: `success`, 7 success / 3 skipped. I re-read the
   three skips' `if:` conditions myself in `.github/workflows/test.yml`
   (dependency-audit:3194+5, awards-data-freshness:3228+22, visual-regression:5182+2) —
   all three are `github.event_name == 'schedule' || 'workflow_dispatch'`, i.e. skipped
   BY DESIGN on a push. No test.yml-triggering commit landed between that run and my
   merge (everything in between was `[skip ci]` or non-allowlisted data paths).

2. **Priority (b) — safe-form allowlist. CLOSED, nothing left to widen.**
   `node scripts/audit-safe-form-allowlist.js --candidates` → **`candidates (scan clean,
   NOT yet allowlisted): 0`**. The list is saturated for audit-*/lint-* scripts; a
   further widening would require giving a write-ing script a read-only mode, not
   editing the list. 14/14 tests in `scripts/lib/safe-form-allowlist.test.mjs` pass.

3. **All three crown gates exit 0** on current main:
   `audit-outlet-registry.js --strict` (Missing: 0 outlets), `audit-critic-outlets.js
   --strict`, `node --test scripts/lib/merge-reviews-json.test.mjs` (28 pass / 0 fail).
   `validate-data.js` exits 0 (its output is warnings, not errors).

4. **NEW ROOT CAUSE — five red workflows on main, one cause.** See below. Shipped the
   systematic guard for the class: `deadline-cannot-fund-retries` in
   `scripts/lib/audit-push-retry-budgets.js` (+ CLI section, + 13 tests, 60 pass).

## THE FINDING — main's non-test.yml reds are ONE bug, and it is not what BRO-2373 says

Five workflows were red on main at 2026-09-02 21:45Z and **every one failed at its push
step**: Rebuild Reviews Data, Rebuild Reviews (Fast), Fetch Guardian Reviews via API,
Update Show Score Data, Commercial RSS Poll (+ Opening Night Broadcast, which also
fails a checklist gate). Failed-step names: "Commit changes" / "Commit and push
changes" / "Commit data" / "Commit data changes".

**Every `git push` runs for exactly 90.00s and is hard-killed** by
`push-with-retry.sh`'s `_timeout` wrapper at `GIT_NET_TIMEOUT_SEC=90`
(scripts/lib/push-with-retry.sh:95, 133). Two independent runs, timestamps straight
out of the logs:

    run 33679833284 rebuild-reviews.yml   900s/25 -> "deadline 900s exceeded after 6 attempt(s)"
      20:37:56 -> 20:39:25.84  = 90.0s     20:39:28.83 -> 20:40:58.87 = 90.0s
      20:41:05 -> 20:42:35.07  = 90.0s     20:42:37.07 -> 20:44:07.11 = 90.0s
      ... 10 consecutive pushes, every one 90.0s
    run 33681436855 fetch-guardian-reviews.yml 240s/7 -> "deadline 240s exceeded after 2 attempt(s)"
      20:53:07.96 -> 20:54:37.97 = 90.01s  20:56:18.68 -> 20:57:48.68 = 90.00s

The fetch is fine (0-2s, task #466's `--shallow-since` bounding works). Only the push
hangs. **A rejected push returns in ~1s** — I measured that against this repo's origin
from this worktree (`git push origin HEAD:refs/heads/main` while 2 behind → rc=1 in 1s;
`git ls-remote` 0-1s; a branch push 2s). So this is the hang/slow-push ceiling, NOT the
ordinary race-loss path.

**BRO-2373's stated cause is wrong for this.** It says "shallow-fetch fails identically
on every retry (rc=128)". The fetch is not what fails. **BRO-2435's "why more budget
will not work"** reasoning ("sustained race loss") is also not what today's logs show:
a race loss is 1s, and these are 90s timeouts.

`push-with-retry.sh:1739`'s own comment already names this class — task #1810,
update-show-status.yml, "a 90s GIT_NET_TIMEOUT_SEC hang here printed NOTHING, which is
why [it] went undiagnosed in CI logs for 4+ days". It is undiagnosed again.

**Still unknown, and the next real step:** WHY the push takes >90s while the fetch takes
1s. `.github/workflows/diag-fetch-timing.yml` exists as the task-#466 harness that
answered this for the FETCH side (it records the repo as 165k commits / 1.16M objects /
1.65 GiB, checked out at depth-1 by actions/checkout's default). Nobody has run the
equivalent experiment for the PUSH side. That workflow is rule-18 gated
(`.github/workflows/**`), so it needs a recorded plan verdict first.

## What I shipped (main 5ca25050a9e, two commits)

`12430057068` + `7f57991833a` — a third, independent flag in
`scripts/lib/audit-push-retry-budgets.js`. The two existing flags model an attempt as
costing only its backoff SLEEP, so the shared 7/240 default reads "ratio 0.32, deadline
is generous" when it in fact funds **2 attempts of 7**. The new model charges
`2 * GIT_NET_TIMEOUT_SEC + backoff` per iteration (one iteration can spend the cap
twice: loop-top `git_push`, then the post-resolution `git_push`).

**It reproduces run 33681436855's "after 2 attempt(s)" exactly**, and is conservative
against 33679833284 (predicts 5, observed 6). **185 of 208 call sites cannot fund 3
attempts.** Report-only — this audit is advisory in CI and no push behaviour changed.

Codex adversarial review found four real defects in the first commit, all fixed in the
second: (1) `WORST_CASE_ATTEMPT_SEC` was a FLOOR not a ceiling (more capped ops per
iteration are possible), so `fundableAttempts` is an UPPER bound and a silent flag
proves nothing — renamed `MIN_TIMED_OUT_ATTEMPT_SEC`, direction of error documented in
the header AND the CLI section; (2) the 90 was a hardcoded copy — now parsed out of
push-with-retry.sh with a test asserting provenance; (3) the backoff formula existed
twice — extracted `backoffForAttempt()`, test asserts agreement with
`computeBackoffSum` for N=0..30; (4) the new flag fires on 89% of sites, which
collapsed the pre-existing "retries-undersized ONLY" summary from ~198 to ~0 — now
excluded from that count (187 of 203).

Mutation-tested before the review: 1x-instead-of-2x attempt cost, and requiring a whole
attempt to fit under the deadline, each fail 4 of the new tests.

## Remaining / next

- **CI run 33688861999 on `5ca25050a9e` was IN PROGRESS when this was written.** Verify
  it job-by-job. Expect 7 success / 3 skipped.
- The push-hang root cause is open. Suggested next step: file it as a P0 correcting
  BRO-2373, then get a plan verdict for a push-timing arm in diag-fetch-timing.yml.
- BRO-2740 (156 orphaned wrongProduction provenance) — untouched by design.
- BRO-2741 (headless jobs report done while work is killed) — detection still reverted.
- BRO-2751 needs an INTERACTIVE session (rule-18 workflow edit) — unchanged from v28.
- 492 of 654 open P0/P1 Linear issues pass the dual-predicate funnel (armed +
  headless-dispatchable); 283 of those are Backlog, 8 Todo. Nothing dispatched — cmux
  is still at its terminal ceiling and a headless session cannot monitor a fan-out.

## Exact next command

    scripts/lib/wait-for-run.sh 33688861999 20     # then check job-by-job
