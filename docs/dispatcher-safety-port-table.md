# Dispatcher safety behaviours — port-or-delete table (BRO-381 Phase 2)

**Scope.** Every safety behaviour the Broadway Scorecard dispatcher carries today, and a PORT/DELETE
decision for the Notion → Linear dispatcher transition. "The dispatcher" here is
`scripts/bsc-next.js` (the legacy Notion-mirror dispatcher) plus the primitives and guards it calls;
the **port target** is `scripts/linear-next.js` (the Linear-issue dispatcher).

This table gates switching `bsc-next.js` off: an unported safety behaviour is exactly how the
replacement inherits the original's failure modes, so **no row is left undecided.**

**How to read the decision column.**

- **PORT — done**: the behaviour already lives in a *shared* module (`dispatch-guards.js`,
  `dispatch-ledger.js`, `cmux-launch.js`, `bsc-runner.js`, `bsc-next-model.js`, `verify-gate.js`,
  `headless-dispatchability.js`, `linear-dispatch.js`) and `linear-next.js` already calls it. No
  work; the row documents that the port is complete and must not regress.
- **PORT — TODO**: the behaviour still lives only on the `bsc-next.js` path (or only fires there) and
  `linear-next.js` has no equivalent. Named target given.
- **DELETE**: Notion-mirror / native-task-shaped, and either the Linear path already has a native
  analog or the behaviour is meaningless once the Notion loop is retired. Reason given.
- **N/A — inherited**: real safety, but repo-global / session-side, not owned by the dispatcher.
  Both dispatchers' sessions inherit it unchanged; nothing to port.

**Verification.** Every `file : function` reference below is checked against the tree at this
branch's HEAD by an executable test — `tests/unit/dispatcher-safety-port-table.test.mjs` (registered
in `tests/unit-test-manifest.txt`). That test `require()`s the real modules and asserts each named
export exists, and asserts the PORT — done rows are actually called by `linear-next.js` while the
PORT — TODO rows are not yet — so this table cannot silently drift from the code.

---

## A. Duplicate / dead / parked guards (workspace-shaped)

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| A1 | **Duplicate-dispatch guard** — refuse a 2nd workspace whose title matches a live (non-✅) session on this task | `dispatch-guards.js : findLiveWorkspaceForTask` (+ `dispatch-ledger.js : titleMatchesSubject`) | **PORT — done** | Shared lib; `linear-next.js` calls it (both cmux + headless paths). Keep shared. |
| A2 | **Dead-attempt circuit breaker** — refuse blind re-dispatch after `DEAD_ATTEMPT_LIMIT=2` substantive deaths (or `INFRA_DEAD_ATTEMPT_LIMIT=10` infra deaths) | `dispatch-guards.js : deadDispatchGuard` → `dispatch-ledger.js : dispatchCapDecision` / `classifyDeadAttemptsForTask` | **PORT — done** | Shared; reached via `checkDeadDispatch`, which `linear-next.js` calls. Infra vs substantive split lives in the ledger. |
| A3 | **Dead-dispatch self-heal** — journal now-idle unmarked workspaces as `dead` breadcrumbs (dual-signal: `claudeAliveIn` AND terminal-surface) so a same-session burst can't sail past A2 | `dispatch-guards.js : checkDeadDispatch` (+ `dispatch-ledger.js : deadBreadcrumbs`) | **PORT — done** | Shared; `linear-next.js` runs it and appends the breadcrumbs. |
| A4 | **Owner-close park guard** — a tab the owner closed without ✅ is "stop working this card"; refuse to reopen until `--force` | `dispatch-guards.js : parkedGuard` → `dispatch-ledger.js : parkedTasks` | **PORT — done** | Shared (takes a `cliName` param so the escape-hatch line prints the right script). `linear-next.js` calls it. |
| A5 | **Cross-session work-branch collision guard** — refuse if a local `worktree-<id>-*` / `job/<id>-*` branch already carries commits not on `origin/main` (another session already did the work) | `dispatch-guards.js : workBranchCollisionGuard` + `worktree-branch-guard.js : listWorkBranchStatuses` | **PORT — done** | BRO-278: the id-anchored match had a real bug beyond just "not wired in" — `matchesTaskWorkBranch` compared the raw ledger taskId (`linear:BRO-278`) against branch names, but `bsc-runner.js`'s `gitSafeJobId()` sanitizes that colon to a dash before the branch is created (`job/linear-BRO-278-<suffix>`), so the match could never fire for any Linear dispatch even after porting. Fixed by sanitizing with `gitSafeJobId` inside `matchesTaskWorkBranch` itself, then wiring the same `listWorkBranchStatuses` → `workBranchCollisionGuard` block `bsc-next.js` uses into `linear-next.js`. This was the root cause of the 2026-08-12 incident (three cmux workspaces independently working the same Linear issue, undetected). |
| A6 | **Notion→Linear mirror guard** — refuse a Notion dispatch when the task already maps to a live Linear issue | `dispatch-guards.js : linearMirrorGuard` (+ `loadLinearMirrorMapping`) | **DELETE** | Exists only to keep the *legacy* Notion path from colliding with Linear during the transition. Once `bsc-next.js` is retired the direction is meaningless; the reverse (Linear→Notion) is not needed because Linear becomes the single source of truth. Delete with the Notion dispatcher. |
| A7 | **No dispatch-time auto-prune (design invariant)** — dispatch never closes ✅/idle tabs out from under the owner (owner rule 2026-07-15) | `bsc-next.js` main() (absence of any close call); `linear-next.js` likewise never closes tabs | **PORT — done** | Invariant already holds on the Linear path (it only ever *appends* dead breadcrumbs, never mutates cmux). Documented so a future edit doesn't reintroduce a dispatch-time close. |

## B. Verifiability / acceptance gates (card-text-shaped)

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| B1 | **Verify-command gate** — refuse to dispatch a card with no runnable `## Acceptance criteria` command (unless `--allow-unverifiable` or `VERIFY: owner-judgment`); arms the nightly recheck | `verify-gate.js : evaluateVerifiability` (re-exported via `dispatch-guards.js`) | **PORT — done** | Shared; `linear-next.js` calls it on `issue.description`. Linear always has the full description, so it refuses outright instead of warning on a truncated mirror. |
| B2 | **Headless human-gate refusal** — refuse `--headless` when an unattended session can't *finish* the card (visual-qa approval, owner decision, long external wait) | `headless-dispatchability.js : classifyHeadlessDispatchability` (re-exported via `dispatch-guards.js`) | **PORT — done** | Shared; `linear-next.js` runs it for `routing.mode === 'headless'`. |
| B3 | **Stale-outcome guard** — refuse a card whose Notion **Outcome** property (or native `status:completed`) already records finished work with no criteria to re-verify (#383 done-but-never-closed) | `dispatch-guards.js : staleOutcomeGuard` / `isNativeTaskDoneWithoutCard` | **DELETE** | Reads the Notion **Outcome** property and native task `status` — neither exists on a Linear issue. The Linear-native analog is **B4** (`checkTerminalStateGuard`, Done/Canceled state), already present. Delete with the Notion path. |
| B4 | **Terminal-state guard (Linear analog of B3 + B5)** — refuse dispatch of a Done/Canceled Linear issue | `linear-dispatch.js : checkTerminalStateGuard` (called in `linear-next.js`) | **PORT — done** | Already the Linear-native replacement for B3 + `completedLaunchGuard`. Keep. |
| B5 | **Completed-launch guard** — refuse launching a task already `status:completed` (typo'd task #) unless `--force`; RECHECK-AFTER-exempt | `bsc-next.js : completedLaunchGuard` | **DELETE** | `task.status` is a Notion-mirror/native field. Superseded by **B4** on the Linear side. Delete with the Notion path. |

## C. Launch-verification primitive (`cmux-launch.js`) — shared

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| C1 | **Launch verified, not assumed** — state machine confirms the typed command actually started claude before reporting success; slow-boot cap (`slowBootCapSec=360`) never triggers a destructive relaunch | `cmux-launch.js : launchCmuxSession` / `waitForLaunchOutcome` + `cmux-launch-state.js : decideLaunchWait` | **PORT — done** | Shared primitive; `linear-next.js` calls `launchCmuxSession` with the same `verifyTimeoutSec:90 / lateAdoptSec:60 / slowBootCapSec:360` budget. |
| C2 | **Dual-signal liveness** — cmux tag AND a real OS process for this launch's nonce-suffixed marker must both agree (closes the #548 false-positive) | `cmux-launch.js : verifiedAlive` / `osProcessAliveForSeed` / `hasSeedProcess` | **PORT — done** | Inside the shared primitive. Inherited by `linear-next.js`. |
| C3 | **Late-start adoption** — a claude that registers just past the verify window is adopted (`adoptedLate`) instead of reported dead → duplicate | `cmux-launch.js : shouldAdoptLateStart` / `strictlyAliveWorkspace` | **PORT — done** | Shared primitive. |
| C4 | **Auth preflight** — refuse to open a doomed tab when claude auth is broken (fail-closed; kill switch `CMUX_AUTH_PREFLIGHT_DISABLED`) | `cmux-launch.js : shouldRefuseForAuth` | **PORT — done** | Inside the shared primitive. |
| C5 | **Deferred-render / idle-gated pre-wake** — force cmux to render a backgrounded surface so the `--command` actually runs (else INJECTION_NEVER_RAN → duplicate factory); idle-gated to avoid amplifying concurrent batches | `cmux-launch.js : shouldPreWake` / `cmuxIdleSec` / `setAppFocus` / `osActivateCmuxApp` | **PORT — done** | Inside the shared primitive. |
| C6 | **Launcher-outage cross-task detector** — one dead launch is the task's problem; the same INJECTION_NEVER_RAN across ≥3 tasks in 30 min is cmux's problem — surface it | `dispatch-ledger.js : detectLauncherOutage` (called in `bsc-next.js` failure path) | **PORT — TODO** | Detector is shared/pure but **only `bsc-next.js` invokes it** on launch failure. Port target: call `detectLauncherOutage` in `linear-next.js`'s `!res.ok` branch after journaling the failed entry (it currently journals the dead entry but never runs the cross-task check). |

## D. Context-limit succession (`bsc-next.js`) — Notion-path only today

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| D1 | **Succession depth cap** — a context-limit handoff chain is hard-capped at `SUCCESSION_DEPTH_CAP=5`, derived from the ledger (never caller-supplied) so a task that never finishes can't chain successors forever | `bsc-next.js : successionRefusal` + `dispatch-ledger.js : successionDepthForTask` / `SUCCESSION_DEPTH_CAP` | **PORT — TODO** | Mechanism is generic (ledger-derived depth). Needed once Linear sessions self-dispatch successors at context limit. Port target: a `--succession` path on `linear-next.js` reusing `successionRefusal`. Until then, Linear sessions have **no** context-limit succession, capped or otherwise — decide whether that is in-scope for the Linear cutover or deferred. |
| D2 | **Succession TOCTOU lock** — per-task atomic-mkdir lock over the read→check-cap→launch→append window so two concurrent successors can't both pass the cap | `bsc-next.js : acquireSuccessionLock` / `releaseSuccessionLock` | **PORT — TODO** | Ports together with D1 (meaningless without it). |
| D3 | **Succession-cap owner page** — best-effort digest alert when the cap is hit | `bsc-next.js : pageSuccessionCapExceeded` | **PORT — TODO** | Ports together with D1. |

## E. Mid-flight correction & overlap (`bsc-next.js`) — Notion-shaped today

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| E1 | **Amend — re-deliver a corrected card into the live session running it**, refusing when the workspace is dead/recycled or sitting at a permission dialog (never type into a stranger's session or answer a dialog) | `bsc-next.js : runAmend` / `occupantStillThisTask` + `dispatch-card-drift.js : detectDrift` / `looksUnsafeToType` | **PORT — TODO** | The drift risk (edit the issue after launch; the session keeps running the original seed) exists identically for Linear. Port target: a `--amend` path on `linear-next.js` reusing `dispatch-card-drift.js`, sourcing current text from `linear.getIssue` instead of `notion-brain get`. Lower priority than C6 (A5 is done). |
| E2 | **Cross-task overlap warning** — non-blocking warn when a fresh dispatch shares a `scripts/` path or near-identical title with in-progress work | `bsc-next.js` main() + `dispatch-overlap-check.js : findOverlappingCards` | **PORT — done** | Superseded by task #1696, which landed after this table's first draft. `linear-next.js` now calls `findOverlappingCards` over a pool built by its own `buildOverlapComparisonPool()`, combining live Linear issues (`state.type === 'started'`) with in_progress Notion-mirror tasks — so the check spans BOTH sides of the mirror rather than only the Notion one. That is why the original **DELETE** verdict no longer holds: the objection was that the guard read a Notion-only task directory, and it no longer does. Keep shared. |
| E3 | **CI-red claim auto-invocation** — record a CI-red fix claim at dispatch so another session's push-gate sees the symbol is being worked | `bsc-next.js : recordCiRedClaim` + `ci-red-dispatch-heuristic.js : extractCiRedTarget` | **PORT — TODO** (low priority) | Cross-session safety that is genuinely dispatcher-agnostic, but `extractCiRedTarget` reads the Notion task+card shape. Port target: feed it the Linear issue title/description, invoke from `linear-next.js` at its confirmed-dispatch points. Niche; safe to defer. |

## F. Selection policy & kill switches

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| F1 | **Human-territory exclusion** — never auto-pick Marketing/Partnerships or short human-action imperatives (only explicit `--id`/`--pick`) | `bsc-next.js : actionable` + `autonomous-eligibility.js : isExcludedCategory` / `EXCLUDED_CATEGORIES` | **DELETE** | Keys on the Notion **category**. Linear's selection policy is label + priority (`linear-dispatch.js : sortIssuesByPriority` / `issueLabelNames`, and mac-only routing). If a "don't auto-pick human work" rail is still wanted on Linear, express it as a Linear **label** filter in `linear-dispatch.js`, not a port of the category list. Delete the category coupling. |
| F2 | **Model floor** — dispatched sessions never inherit the interactive default (Fable); floor is Sonnet, Opus only on hint/triage (stops "9 Fable workspaces in one night") | `bsc-next-model.js : resolveModel` | **PORT — done** | Shared; `linear-next.js` calls `resolveModel`. |
| F3 | **Dispatcher kill switch** — refuse all launches when disabled | `bsc-next.js` (`BSC_RUNNER_DISABLED=1`, headless only) / `linear-next.js` (`LINEAR_NEXT_DISABLED=1`, all dispatch) | **DELETE** (`BSC_RUNNER_DISABLED`) | Linear already has a *stricter* native switch (`LINEAR_NEXT_DISABLED` blocks cmux + headless, not just headless). Retire `BSC_RUNNER_DISABLED` with the Notion loop. |

## G. Idempotency & headless runner — Linear-native / shared

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| G1 | **Linear idempotency (dual signal)** — refuse if the issue thread already carries an unresolved "Dispatched …" comment OR the ledger has a live entry; ledger write ordered BEFORE the Linear comment for crash-safety | `linear-dispatch.js : findUnresolvedDispatchComment` / `hasLiveLedgerEntry` (called in `linear-next.js`) | **PORT — done** | Linear-native replacement for the Notion duplicate machinery. Keep. |
| G5 | **Reported-outcome guard** — refuse re-dispatch of a **started**-type issue whose most recent "Dispatched …" comment has already been answered by a `done`/`in-review` session report or a `PR-EVIDENCE:` marker; **not** bypassed by `--force`, only by `--allow-reported-work "<reason>"` (journaled on the ledger row) or the `REPORTED_OUTCOME_GUARD_DISABLED=1` incident switch | `linear-dispatch.js : reportedOutcomeGuard` (called in `linear-next.js`) | **PORT — done** | Linear-native, no Notion analog (BRO-2543). Closes the gap G1 cannot: G1's signals both need a dispatch to look *live*, and this population is the opposite — a dispatch that already finished and reported, on a workspace the ledger has (sometimes wrongly) marked `dead`. Refuses only when the report is **newer than** the outstanding dispatch comment, so a genuine re-dispatch after a real death is untouched. `blocked`/`paused` reports deliberately do not count — that is the stall `--force` exists to recover. |
| G2 | **Per-task headless lease** — one live headless job per task (cross-dispatcher; atomic file lease, PID-checked) | `bsc-runner.js : acquireLease` / `releaseLease` / `pidLooksLikeClaude` | **PORT — done** | Shared; `linear-next.js` reaches it via `runJob`. The lease is blind to a live cmux **tab** — which is why both dispatchers *also* keep the `findLiveWorkspaceForTask` tab check on the headless path. |
| G3 | **Per-job spend / wall-clock budget** — headless job runs under a budget preamble + timeout | `bsc-runner.js : buildBudgetPreamble` / `runJob` (timeout) | **PORT — done** | Shared via `runJob`. `linear-next.js` passes `killSwitchEnv:'LINEAR_NEXT_DISABLED'` so the runner answers to the Linear switch, not the retired Notion one. |
| G4 | **Headless worktree isolation** — each job runs in its own git worktree; kept only if it has unmerged work | `bsc-runner.js : provisionJobWorktree` / `teardownJobWorktree` | **PORT — done** | Shared via `runJob`. |

## H. Downstream & repo-global (not dispatcher-owned)

| # | Safety behaviour | Lives today (file : function) | Port or Delete | Rationale / target |
|---|---|---|---|---|
| H1 | **Nightly acceptance recheck** — re-run the `verifyCmd` captured at dispatch against fresh main days later; shadow-mode, never auto-reopens until the shadow record clears the bar | `scripts/autonomous-acceptance-recheck.js` (reads the dispatch ledger + Notion Done/Paused board) | **PORT — TODO** | The dispatcher's *raison d'être* for the verify gate (B1). `linear-next.js` already **captures** `verifyCmd` into the ledger, but the recheck only walks the **Notion** board, so Linear-dispatched Done work is never re-verified. Port target: a Linear-issue recheck pass that lists Done Linear issues and re-runs their ledger-captured `verifyCmd` (the ledger already carries `linearId`). Real gap — arguably the most load-bearing TODO here. |
| H2 | **Push mutex** — serialize concurrent pushes (flock) so parallel sessions/CI can't clobber each other | `scripts/lib/push-mutex.sh` (sourced by `push-with-retry.sh`) | **N/A — inherited** | Repo-global, session-side; every dispatched session inherits it regardless of dispatcher. Nothing to port. |
| H3 | **Push retry / rebase / deadline / deadman / content-survival** — bounded retry with auto-conflict-resolution, an overall deadline, a conflict-marker guard, a content-drop guard, and a failure ledger | `push-with-retry.sh` + `push-retry-deadman.js` + `push-content-survival.js` | **N/A — inherited** | Repo-global push primitive; dispatcher-agnostic. Inherited unchanged. |
| H4 | **Infra plan-review gate** — first edit to shared infra (dispatch layer, spend guards, workflows, hooks) is blocked until a `/second-opinion` or `/plan-review` verdict is recorded | `scripts/lib/review-gate.mjs` (`record-plan` / pass / fail / owner-override) + `infra-plan-review-gate.sh` hook | **N/A — inherited** | Session/hook-side gate over *editing* dispatcher code; not a runtime dispatch behaviour. Applies to whoever edits `linear-next.js` too. Nothing to port. |
| H5 | **Run-budget for cron backlogs** — cron scripts stop cleanly before the workflow SIGKILL and report remaining backlog | `scripts/lib/run-budget.js : createRunBudget` | **N/A — inherited** | Generic cron helper; not dispatcher-owned. |

---

## Summary

| Decision | Count | Rows |
|---|---|---|
| **PORT — done** (already shared + used by `linear-next.js`) | 16 | A1–A5, A7, B1, B2, B4, C1–C5, E2, F2, G1–G5 |
| **PORT — TODO** (bsc-next-only; needs a Linear equivalent) | 6 | C6, D1–D3, E1, E3, H1 |
| **DELETE** (Notion/native-shaped; Linear has a native analog or it's moot post-cutover) | 5 | A6, B3, B5, F1, F3 (`BSC_RUNNER_DISABLED`) |
| **N/A — inherited** (repo-global / session-side, not dispatcher-owned) | 5 | H2–H5 (+ push family) |

**The load-bearing PORT — TODO items**, ranked:

1. **H1 — Linear acceptance recheck.** `linear-next.js` already arms the verify gate and writes
   `verifyCmd`+`linearId` to the ledger, but nothing re-runs it for Linear issues
   (`autonomous-acceptance-recheck.js` walks only the Notion board). Without this the whole
   verify-gate contract is half-wired on the Linear side.
2. **C6 — launcher-outage detector.** Shared/pure already; the only gap is that `linear-next.js`
   doesn't *call* it. Cheap, high-value. (A5 is done — see above.)
3. **D1–D3 — succession.** A policy call: is context-limit succession in scope for the Linear cutover,
   or deferred? If deferred, Linear sessions simply have no succession (state the gap explicitly).
4. **E1 (amend), E3 (CI-red claim).** Genuine but niche; safe to defer.

**The DELETE items are safe** because each is coupled to a Notion-only data shape (the Outcome
property, the native `task.status`, the Notion category, the mirror task directory, or the
`BSC_RUNNER_DISABLED` plist switch) and the Linear path either already carries a native analog
(B4 for B3/B5, G1 for E2, `LINEAR_NEXT_DISABLED` for F3, label routing for F1) or the behaviour is
meaningless once `bsc-next.js` is retired (A6).
