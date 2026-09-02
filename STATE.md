# STATE — headless crown successor (BRO-343 v28), 2026-09-02

Branch: `job/crown-BRO-343-v28-headless-mtkkeeoe`
Commit: `be076bd1fa0` — committed, NOT yet merged to main.

## DONE (verified, not assumed)

1. **Priority (a) — CI on main is GREEN job-by-job.** Latest full `test.yml` run on
   main is **33674821020** (sha `a88ac225d2a`): `Unit Tests`, `TypeScript Check`,
   `Test Summary`, `Lint Workflows`, `E2E Tests`, `Design Token Drift Guard`,
   `Data Validation` all `success`. The 3 `skipped` jobs (Dependency Audit, Visual
   Regression, Awards Data Freshness) are schedule/dispatch-gated by design, as v28
   Addendum 2 documented. Every commit on main after `a88ac225d2a` is data-only
   (review-text checkpoints, `public/data`, `data/audit`, `scratchpad`, `STATE.md`)
   — `git diff --name-only a88ac225d2a 01df5f66607` shows zero `src/`, `scripts/`
   or `.github/` changes, so no untested code sits on main. Nothing red to fix.

2. **Priority (b) — the safe-form allowlist widening was ALREADY SHIPPED** by the
   previous session (v28 Addendum 2 supersedes the launch prompt's §3). Verified
   independently, not taken on trust: `AUDIT_LINT_GENERIC_FORM_ALLOWED` holds **39**
   entries and `node --test scripts/lib/safe-form-allowlist.test.mjs` is **14/14
   pass**. Re-ran the same 300-card sample: **armed 144 / refused 156 (52%)**,
   matching Addendum 2's 145/155 within normal card drift.
   **Widening further is now low-value:** only **6** of the 156 refusals are
   `basename`. The real remaining buckets are `no-command 89`, `shape 37`,
   `no-section 24`. BRO-2747 correctly documents that `audit-outlet-registry.js
   --strict` must STAY refused (it writes a git-tracked file).

3. **P0 BRO-2732 root-caused and step 1 shipped to this branch.**
   ("P0: rebuild-reviews.yml push step fails every run - rebuilt reviews.json is
   DISCARDED, no new review can reach prod")
   - Its acceptance criterion is now **partially met on its own terms**: the
     boycotting-trends review for electra-persona-west-end-2026 IS in reviews.json
     with `assignedScore 79` (21 entries for that show). So reviews ARE reaching
     prod again; the workflow is degraded, not dead.
   - **The "write contention" reading is WRONG** and should not be re-derived.
     In run 33678227543 attempt 3, fetch completed 20:25:17Z and the post-resolution
     push failed 20:26:48Z = 91s = exactly `GIT_NET_TIMEOUT_SEC=90`, while
     `origin/main` took ZERO commits in that window (20:25:12Z, then 20:28:04Z).
     It is a **transport hang**, not a lost race.
   - Shipped (diagnostic only, zero control-flow change): `describe_push_rc()` plus
     instrumentation of **both** `git_push` call sites, so a failed push names its
     exit code and elapsed time. rc 124/137 are labelled as hangs; anything else is
     reported as a plain rc.

## THE REVIEW CAUGHT TWO HARD-ABORT BUGS — do not repeat them

The rule-18 `/second-opinion` (plan verdict recorded, `record-plan`) found that the
first draft would have made things WORSE:
- `local` outside a function. These branches live in the top-level
  `for i in $(seq 1 "$MAX_RETRIES")` loop, and the script runs `set -euo pipefail`
  (line 29), so `local` aborts the whole script and fires the EXIT trap — turning a
  TRANSIENT push failure into a hard exit that skips every remaining retry AND the
  Git Data API fallback.
- `$((SECONDS - push_start))` with no `push_start` in scope — same abort under
  `set -u`.
Both are now guarded structurally by test 3 and test 4 of the new suite, and the
structural guard is mutation-verified (injecting a top-level `local` is caught).

**I rejected one of the reviewer's suggestions on purpose.** It wanted
`record_push_failure()` called on these paths. Do NOT add it: that function's
durable telemetry write is gated to the FIRST call per invocation, so a merely
transient post-resolution timeout — one a later attempt often recovers from —
would write a durable "push failed" row for a run that ultimately SUCCEEDED, and
`scripts/lib/push-retry-deadman.js` would surface healthy runs as failures. That is
the same class as v28's "42% of headless jobs flipped to FAILED" lesson.

## EXACT NEXT COMMAND

**The review gate is now GREEN and the branch is pushed to origin.** ship-check ran,
found one real blocker (below), it was fixed and re-verified, and the verdict is
recorded bound to THIS branch's exact head + diffHash
(`allowed:true, via:"exact-hash", head 951a195f32f, gatedLines 235`) — not the
stale cross-worktree verdict the gate was citing earlier (@19:40:41Z), which is
exactly the false-positive v28 warned about.

**So the ONLY remaining step is the merge itself.** I did not start it because the
session's hard time ceiling was reached, and a merge killed mid-flight would leave
a merge commit sitting locally on the shared main checkout — the one thing the
rules say never to do.

1. `scripts/merge-worktree-to-main.sh job/crown-BRO-343-v28-headless-mtkkeeoe`
   (`run_in_background: true`, NEVER a `timeout` prefix)
2. Confirm the resulting `test.yml` run is green job-by-job, specifically the new
   step "Run push-with-retry push-rc diagnosis test (bash integration)".
3. Then comment the outcome on BRO-2732 and leave it OPEN — step 1 of its stated
   3-step approach is done; steps 2 and 3 (re-run rebuild-reviews.yml, read the
   now-visible rejection, fix the real cause) still need a live failing run.

## VERIFICATION EVIDENCE (all run in this session, after the edits)

- ship-check BLOCKER found and fixed: the fixture hard-failed on any machine
  without `init.defaultBranch` set (`git init --bare` pins the bare repo's HEAD to
  `master` and never re-points it on first push, so the second clone landed on an
  unborn branch). Fixed with `git init --bare -b main`, then re-verified by running
  the suite under a scratch `GIT_CONFIG_GLOBAL` — 4/4 PASS there too.
- The reviewer's `ext::sh -c 'sleep 120'` transport suggestion was TRIED AND
  REVERTED: as a push-only URL alongside a file:// fetch URL it is rejected
  outright (rc=128 in 0s) instead of hanging. Do not retry it in that form.
- `bash scripts/lib/push-with-retry.push-rc-diagnosis.test.sh` — 4/4 PASS, exit 0.
  Exercises both branches against a REAL git remote (local bare repo for fetch,
  non-routable `10.255.255.1` push URL to force the hang), not a mock.
- All 8 pre-existing `scripts/lib/push-with-retry.*.test.sh` suites — exit 0 each.
- `node scripts/audit-test-yml-lib-deps.js`, `audit-test-yml-manifest-paths.js`,
  `audit-workflow-concurrency.js`, `audit-reconcile-coverage.js` — all exit 0.
- `bash -n scripts/lib/push-with-retry.sh` — clean.

## UNTOUCHED / STILL OPEN

- BRO-2740 (156 orphaned wrongProduction provenance files) — untouched by design.
- BRO-2741 (headless jobs report done while their work is killed) — detection still
  reverted; the 65-log labelled dataset is on the card.
- BRO-2748 (path containment mutation) — untouched.
- Rebuild Reviews (Fast) / Rebuild Reviews Data / Opening Night Broadcast are still
  failing on main; BRO-2732 step 1 is what makes the next failure diagnosable.
- Disk on `/System/Volumes/Data` is **14Gi free, down from 16-17Gi** at v28 handoff.
  Worth watching; 33 worktrees.

## OWNER DECISIONS — still pending, NOT mine to make (headless, cannot ask)

1. iOS overnight worktrees (`~/BroadwayScorecard-app`, Aug 31 + Sep 1
   `feedback-overnight`): review+merge vs confirmed discard. Each holds ONE real
   unmerged commit of TestFlight beta-feedback fixes. Recommendation: review+merge.
2. Forbes / Marc Hershberg walkthrough date. Recommendation: mid-to-late October
   walkthrough, ahead of a Nov 1 publish rather than depending on it.

Reminder (not a decision): Cyrus Team Cloud $120/mo cancellation needs the owner's
hand on an external dashboard — no CLI/API path exists on this machine.
