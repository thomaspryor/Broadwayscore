# BRO-2318 session state (handoff)

Linear: https://linear.app/broadway-scorecard/issue/BRO-2318 — still "In Progress", no comment posted yet.
Worktree: /Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-BRO-2318-mta79vcn, branch job/linear-BRO-2318-mta79vcn.

## Plan-review verdict (already recorded — do NOT re-run /second-opinion)
`.claude/review-verdicts.jsonl` has a `record-plan` pass entry for this session (reviewer=second-opinion). The independent review's key findings, already incorporated below:
- Denominator/numerator for the new rate fn must BOTH be `isWorkspaceRef`-filtered (cmux-tab launches only). Verified against the live ledger: mixing in headless launches drops the rate from ~32% to ~13%, silently masking the leak.
- Boolean field name must mirror `detectLauncherOutage`'s `outage` — used `leaking` (not `alarm`).
- Add a zero-launch guard (no division by zero) — done, `rate = totalLaunches > 0 ? ... : 0`.
- Add a parity test proving this fires on exactly the ledger shape that makes `detectLauncherOutage` report `{outage:false, recovered:true}`.
- Digest wiring (if done) must read the existing dispatch-watchdog **heartbeat file** (`~/.claude/state/dispatch-watchdog.json`, already written every sweep with a `holds: string[]`), NOT read dispatch-ledger.js directly — that would be new architecture per the reviewer. Treat this as the lowest-priority remaining step; the core ask (test proving a ledger window alarms even when `recovered:true`) is satisfied by steps 1-2 below alone.

## Done
1. `scripts/lib/dispatch-ledger.js` — added `detectLauncherFailureRate(entries, {now, lookbackMs, minLaunches, rateThreshold})` right after `detectLauncherOutage` (search for "Leaky-launcher failure-rate detector (BRO-2318)"). Returns `{leaking, rate, failureCount, totalLaunches, taskIds}`. Constants: `FAILURE_RATE_LOOKBACK_MS` (6h), `FAILURE_RATE_MIN_LAUNCHES` (8), `FAILURE_RATE_THRESHOLD` (0.2). Exported (function + 3 constants) in `module.exports`.
2. `node --check` passes; `require()` smoke test confirms the export resolves. Committed: `bc76c5ec536` ("WIP BRO-2318: add detectLauncherFailureRate pure fn to dispatch-ledger.js").

## NOT done yet — exact next steps

### Step A (mandatory — this is the acceptance criteria)
Add tests to `scripts/lib/dispatch-ledger.test.mjs`. Import `detectLauncherFailureRate` in the top `require()` line (~line 8, alongside `detectLauncherOutage`). Add a new section after the existing `detectLauncherOutage` tests (after line ~821, before `// ── followRetryChain`). Required cases:
- **The acceptance-criteria case**: build a ledger with ~8+ workspace launches over an interleaved fail/success/fail pattern (~1-in-3 dying with `failureReason: 'command injection never ran (no wrapper process appeared)'`, each 'dead' paired with an `unverified: true` 'launch' per `failedLaunchEntries()`'s real shape), with a verified success as the NEWEST entry. Assert `detectLauncherOutage(entries, {now}).recovered === true` (proving today's blind spot) AND `detectLauncherFailureRate(entries, {now}).leaking === true` in the SAME fixture — this is the parity test the reviewer asked for and the literal acceptance criterion.
- Below `minLaunches`: e.g. 2 launches, 1 injection death (50% rate) → `leaking: false`.
- Below `rateThreshold`: e.g. 10 launches, 1 injection death (10%) → `leaking: false`.
- Respects `lookbackMs`: failures older than the window are excluded from both numerator and denominator.
- Zero launches in window → `{leaking:false, rate:0, totalLaunches:0}`, no throw.
Run: `node --test scripts/lib/dispatch-ledger.test.mjs` — must be 100% green (check no pre-existing failures either, this file is large).

### Step B (wire into the watchdog, so it actually reaches anyone)
`scripts/lib/dispatch-watchdog-core.js` — in `planSweep()` (~line 302-455): call `detectLauncherFailureRate(entries, {now})` right after the existing `const outage = detectLauncherOutage(entries, {now});` (~line 326). Push a hold string to the `holds` array (~line 409-416, alongside the `outage.outage` and `claimOutage` hold pushes) when `.leaking` is true, e.g.:
```js
const failureRate = dispatchLedger.detectLauncherFailureRate(entries, { now });
...
if (failureRate.leaking) holds.push(`cmux launcher leaking (${failureRate.failureCount}/${failureRate.totalLaunches} = ${Math.round(failureRate.rate*100)}% injection deaths in the last ${Math.round(FAILURE_RATE_LOOKBACK_MS/3600000)}h)`);
```
Return `failureRate` on the plan object (~line 445-454, alongside `outage`). `dispatch-watchdog-core.js` already does `const { ..., detectLauncherOutage, ... } = require('./dispatch-ledger.js')` near the top (~line 35) — add `detectLauncherFailureRate` to that destructure.
Check `scripts/tests/dispatch-watchdog-core.test.mjs` — existing `holds` assertions use `.some(h => h.includes(...))`, NOT exact array equality (verified before the interruption), so this is safe, but add one new test there proving the leak hold appears in `holds` and does NOT depend on `outage.outage`/`recovered`.

### Step C (page the owner — mirrors the existing outage pager)
`scripts/dispatch-watchdog.js` `executeSweep()` (~line 306-313): add a second `pageOwner({...})` block for `plan.failureRate.leaking`, parallel to the existing `plan.outage.outage` block, its own `conditionKey` (e.g. `'watchdog-launcher-leak'`) and a `cooldownHours` (6, matching the outage pager).

### Step D (lowest priority — digest surfacing, per the issue's "probably looks like" section, not the hard acceptance test)
`scripts/send-morning-digest.js`: add a `localDispatchWatchdogLeakMessage()` function shaped exactly like `localPrSupervisorMessage()` (~line 176-184) / `localCyrusRelayMessage()` (~line 105-113) — read `~/.claude/state/dispatch-watchdog.json` (JSON.parse, catch→return null), pull `.holds` (array), return the first hold string matching `/cmux launcher leaking/` or null. Wire into the digest's message list near `cyrusMsg`/`supervisorMsg` (~line 392-400). No dedicated test file exists for these `local*Message` readers today (verified — none of `assessCyrusRelay`/`assessSupervisorStatus` have per-reader-function tests in send-morning-digest.js itself), so match that precedent rather than inventing a new test file.

### Step E — required before claiming done (CLAUDE.md rules)
1. `npx tsc --noEmit` clean (should be unaffected — pure JS, but run it, .js files aren't type-checked but adjacent .ts callers might be — none expected here).
2. `npx next lint` — no new warnings.
3. `node --test scripts/lib/dispatch-ledger.test.mjs` full green.
4. `node --test scripts/tests/dispatch-watchdog-core.test.mjs` full green (if Step B done).
5. Run `/ship-check` on the diff (this touches critical-tier dispatch infra — CLAUDE.md rule 18 already satisfied by the plan-review verdict above, ship-check is the separate POST-implementation gate, still required).
6. `node scripts/lib/review-gate.mjs --query=record --reviewer=ship-check --result=pass` (or code-review) — the IMPLEMENTATION-phase verdict, separate from the plan-phase one already recorded.

### Step F — close the loop
1. Commit everything (`git add scripts/lib/dispatch-ledger.js scripts/lib/dispatch-ledger.test.mjs scripts/lib/dispatch-watchdog-core.js scripts/tests/dispatch-watchdog-core.test.mjs scripts/dispatch-watchdog.js scripts/send-morning-digest.js` as applicable), push the worktree branch.
2. Comment on Linear BRO-2318 via `scripts/lib/linear-client.js`'s `createComment()` (grep the repo for an existing CLI wrapper, e.g. `scripts/linear-comment.js` or similar, or call `createComment()` directly in a one-off `node -e`) summarizing: what shipped, the test proving the `{outage:false, recovered:true}`-yet-leaking case now alarms, and how the alarm reaches the owner (holds → crowned tab + heartbeat, pager, optionally digest).
3. Set the issue state to "In Review" via `updateIssue()` in the same lib — do NOT do this until steps A-C (minimum) are done and tests are green. If genuinely blocked, comment what's blocking and leave state as "In Progress" instead of guessing at "In Review" (per the dispatch instructions).

## Exact next command for a resumed session
```
cd /Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-BRO-2318-mta79vcn
sed -n '780,845p' scripts/lib/dispatch-ledger.js   # re-orient on the new function before writing tests
```
Then implement Step A directly in `scripts/lib/dispatch-ledger.test.mjs`.
