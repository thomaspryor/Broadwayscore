# STATE — BRO-2542 (headless, 2026-08-30/31)

## Done and verified
- `scripts/lib/dispatch-reconcile.js` created — exports `findMyJob`,
  `makeIsDispatchResolved(resolvingEvents)`, `reconcileDispatches(dispatches, opts)`.
  Plan reviewed via `/second-opinion` ("Ready to implement"), recorded via
  `node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass`.
  Commit `038d7bb80b4`.
- `scripts/linear-drain-parked.js` ported (reference/simplest case, 2-outcome
  card-pass/card-fail). `findMyJob`/`isDispatchResolved` now delegate to the
  shared lib; `reconcileOutcomes` keeps its own dispatch-filter + note text,
  calls `reconcileDispatches()` for the rest. Commit `d2dfa926d00`.
  Verified: `node --test tests/unit/linear-drain-parked.test.mjs` → 48/48 pass.

## Remaining (port order per issue body)
1. **`scripts/backlog-drain.js`** (lines ~314-421 pre-port — re-check line
   numbers, they've shifted from linear-drain-parked's edit only in that
   file, not this one). RESOLVING_EVENTS = `{card-pass, card-fail,
   card-stranded, completion-unattributed}` — richer vocabulary than the
   reference. `onTerminal` callback must retain the stranded-commit /
   attribution logic (lines ~385-439 in the original: `strandedCommitsFn`,
   `landedFn`, `commitRefFn`, `attribution`, `landedLate`) verbatim — do not
   simplify it, just move it into the `onTerminal(d, job)` callback closure
   (it already closes over `tasksById`, `opts.strandedCommits`, etc., so no
   new plumbing needed per the second-opinion review).
   `identifierOf`/`taskIdOf` are the same field (`d.taskId`, no `linear:`
   prefix) — pass `taskIdOf: undefined` or omit it (shared lib defaults to
   `identifierOf`).
   Verify: `node --test scripts/backlog-drain.test.mjs`
2. **`scripts/lib/digest-autofix.js`** (lines ~442-559 pre-port). Same
   RESOLVING_EVENTS as linear-drain-parked ({card-pass, card-fail}).
   `onTerminal` must retain the `isLinear`/`completed` branching (lines
   ~540-548 of the original — Linear-tracked rows use `sessionOk` alone as
   the pass signal; Notion-mirror rows check `tasksById` status).
   Exported name is `reconcileDigestOutcomes` (not `reconcileOutcomes`) —
   keep that export name, just delegate internals.
   Verify: `node --test scripts/lib/digest-autofix.test.mjs`
3. After both ports: re-run all three test files together (the issue's
   acceptance criterion):
   `node --test scripts/backlog-drain.test.mjs scripts/lib/digest-autofix.test.mjs tests/unit/linear-drain-parked.test.mjs`
   — must be all-pass, unchanged (parity, not new behavior).
4. `/ship-check` on the full diff before closing.
5. Comment outcome on BRO-2542 (Linear GraphQL, `createComment()` in
   `scripts/lib/linear-client.js`) and set state to "In Review"
   (`updateIssue()` in same file). Do NOT leave it silently in "In Progress".

## Exact next command
```
cd /Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-BRO-2542-mtgkdpzm
grep -n "findMyJob\|isDispatchResolved\|RESOLVING_EVENTS\|function reconcileOutcomes" scripts/backlog-drain.js
```
Then port backlog-drain.js the same way linear-drain-parked.js was ported
(see commit `d2dfa926d00` for the exact pattern: replace the duplicated
findMyJob/isDispatchResolved/reconcileOutcomes block with a `require('./lib/dispatch-reconcile.js')`
+ thin `reconcileOutcomes` wrapper calling `reconcileDispatches()`).

## Gotchas
- `scripts/lib/dispatch-reconcile.js` is classified as "session dispatch
  layer" shared infra by `~/.claude/hooks/infra-plan-review-gate.sh` — any
  FURTHER edit to that file (not the three callers) needs a fresh
  `/second-opinion` + `record-plan` before the edit, in a NEW session (the
  gate is per-session). Editing the three caller files does not trigger it.
- No behavior change intended anywhere in this issue — pure extraction.
  Any test diff is a bug in the port, not an accepted new behavior.
