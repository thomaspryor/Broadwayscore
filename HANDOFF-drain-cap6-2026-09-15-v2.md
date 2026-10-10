# Handoff: finish landing the continuous drain, then drain the P1 backlog

You OWN this end to end. Re-verify every claim below yourself — several claims
in the PREVIOUS handoff for this work were falsified on measurement, and one of
my own was too (details below, so you don't repeat the mistake). Report ONE
verdict to the owner with numbers.

## Owner's standing instruction (2026-09-15, verbatim)

> "Get all the P1s and P0s dispatched now"

Earlier in the same conversation: "We should do 6 daily, but just six at a time.
Whenever one is done another should start. We have a HUGE backlog to get
through. We've made no progress in many weeks." Then, on the budget: "24/day
sounds good" — and after that, the instruction above, which is why perDay was
lifted further (see below).

## THE ONE THING BLOCKING RIGHT NOW — do this first

`scripts/lib/dispatch-watchdog-core.js` commit **f8516c52191** (branch
`worktree-continuous-drain-cap6`, in the worktree
`/Users/tompryor/Broadwayscore/.claude/worktrees/continuous-drain-cap6`) is
**NOT on origin/main**. Everything else from this session IS.

It is blocked because a DIFFERENT session left two unpushed commits on the
SHARED local main that fail the pre-push workflow guard:

```
cc598ff4d04 fix: ship-check findings — 14 of 17 FAILED verdicts were false accusations (BRO-3426)
8e214531477 feat: daily evidence re-verification sweep, shadow mode (BRO-3426)
```

The guard's complaint:

```
::error::Workflows invoke a core-data-writing script but never push-core-data
(writes silently discarded at job end): data-health-check.yml(validate-data.js)
Fix: add the push-core-data step (see gather-reviews.yml), or if the write is
genuinely build-local/audit-only, add the workflow to EXEMPT in
scripts/lint-workflow-guards.sh with a one-line reason.
```

My read, NOT verified: `validate-data.js` validates rather than writes core
data, so this looks like a guard false-positive on BRO-3426's new invocation —
in which case the EXEMPT entry is the correct fix. **Confirm that before acting.**
Do NOT `git push --no-verify`: that guard exists because silently-discarded core
data writes have burned this repo before.

Until it is resolved, nobody on this machine can push — it is a fleet-wide
blocker, not just mine.

**What f8516c52191 does (BRO-3404):** splits planSweep's holds into
`cmuxHolds` (cmux unobservable, launcher outage, launcher leaking, the global
auto-tab ceiling) and `globalHolds` (kill switch, day budget, hourly pacing,
watchdog concurrency, fleet-wide claim outage). Budget is gated on
`globalHolds` only; when only cmux holds are active, `toDispatch` is filtered to
headless (`linear:`) work via `taskSourceRank`. `holds` stays the union so every
existing reader is unchanged.

**Why it matters right now:** the live drain is currently HALTED on
`global auto-tab ceiling (15/12)` — a count of cmux TABS — while every card it
cannot dispatch is headless and creates no tab at all. Verified against the real
ledger + workspace listing: with the fix, `globalHolds: []`, `cmuxHolds:
[auto-tab ceiling]`, **budget 2**; without it, budget 0. So until this lands,
the owner's "dispatch everything" instruction is not actually in effect.

A merge conflict already occurred once and I resolved it; it will recur. It is
additive on both sides of planSweep's return — main adds `jobBlocked`, this
branch adds `globalHolds, cmuxHolds` to `budgets`. **Keep both.** Resolved form:

```js
    unlandedDone, jobBlocked,
    budgets: { usedToday, usedThisHour, liveNow, autoTabs, budget, holds, globalHolds, cmuxHolds, pausedByPolicy, caps: CAPS },
```

After landing it, the watchdog MUST be restarted to load the new code (it reads
CAPS and the hold logic at module load). Restart recipe is at the bottom.

## What already shipped and is verified on origin/main

- **`scripts/lib/linear-watchdog-source.js` (new)** — Linear as a second task
  source for the watchdog, modelled on `linear-recheck-source.js`. Pure
  `mapIssueToTask`; the fetcher never throws but reports an outage rather than
  returning an empty backlog (an empty array would read as "no work exists" and
  silently idle the drain). Eligibility is narrower than "open": armed
  (`evaluateVerifiability().cmd`), not `started`, not an autofix-filed tracker,
  and passes `classifyHeadlessDispatchability`. That last gate cut eligible from
  312 to 136 — 176 cards that would each have burned a day-budget CLAIM on a
  guaranteed refusal.
- **`taskPriority`** now parses `[(notion|linear):...]`.
- **`compareTaskIds` + `taskSourceRank`** — replaced three `parseInt` sorts that
  returned `NaN` on `linear:` ids (every comparison false, so the queues
  silently stopped being FIFOs), and Linear now outranks the retired Notion
  mirror.
- **`dispatchArgvFor`** forks on id namespace: `linear:` → `linear-next.js --id
  BRO-N --headless --detach`. The `--detach` is load-bearing — `--headless`
  alone awaits the job for its whole life and `runBscNext` SIGKILLs the process
  group at 15 minutes, which on the real ledger would have killed 277 of 424
  jobs (65.3%).
- **`CAPS`** = `{perSweep:2, watchdogConcurrent:6, perDay:400, perHour:50,
  globalAutoTabs:12}`. perDay 400 is deliberately unreachable so CONCURRENCY (6)
  is the governor; lower it back to ~24 once the backlog drains. perHour derives
  as `ceil(perDay/8)`, so the owner keeps one dial.
- **`detectWriteBackLeak`** — surfaced in the narrative and heartbeat.
- **`digest-snapshots.js`** — removed the dead `backlogDrain` entry whose
  producer was decommissioned 2026-08-31; it had been emitting a permanent
  "stale" line into the owner's morning digest for 15 days.

## Measurements — trust these, they were taken directly

- Watchdog p01Queue: **205 (all frozen-Notion) → ~338**, ~134 Linear.
- Linear board: 1002 open, 722 armed, 136 eligible after all gates (5 P0, 130 P1).
- Lane health since 2026-08-16: headless 460 jobs, **83.0%** job-done (17.0%
  trouble); cmux 462 launches, **30.5%** dead/vanished.
- Write-back: 327 issues with a job-done since 8/16 — 66.7% reached Done (150 of
  those archived-Done, verified individually). Weekly 47→77→90→78→82%. The
  previous handoff's "70% never wrote back" was WRONG.
- Job economics: mean $7.47, median $6.16, p90 $16.92, median duration 22 min.
  **But** `preflightAuth()` returns `mode: 'oauth'` and spawns with
  `ANTHROPIC_API_KEY: ""` cleared — so these are token-cost EQUIVALENTS against
  the subscription, not card charges. API key is a fallback that alerts when it
  engages. I told the owner this correction.
- Machine at handoff: swap **94.5%**, ~681MB physical free, 44 claude processes
  at 7.9GB. This is why "dispatch all 135 at once" was not done literally — it
  would OOM the box. Six-wide continuous is the form that completes (~8 hours).

## What I got wrong — do not repeat it

I claimed the reviewer's "Linear cards are starved behind Notion ids" finding did
not reproduce, because I measured the live queue and found the first Linear card
at index 0 with 7 of the first 12 Linear. **That measurement was real but
shallow and the conclusion was wrong.** A handful of low-numbered Linear ids
(BRO-219/931/995) sat at the head and masked the ordering underneath. Within the
hour, after those drained, four consecutive watchdog claims went straight back to
the Notion mirror (1849, 1904, 1932, 1962). Fixed by `taskSourceRank`, already on
origin/main. Lesson: a head-of-queue sample does not prove an ordering property.

## Still open

- **BRO-3431** ("P0: four LIVE schedules still drive the retired Notion board —
  including the morning digest's backlog number") — DONE and merged by the drain
  itself; it fixed predispatch-queue-audit, bsc-prune, commercial-pending-review
  and reconcile-dead-completions. I posted a comment requiring a systemic guard
  (a check that fails when a live schedule reads the frozen mirror) before it is
  considered closed — verify that guard exists, or reopen.
- **BRO-3404** ("P1: watchdog holds are global — cmux health still gates the
  headless Linear lane it cannot affect") — the fix is f8516c52191 above.
  Close it once landed.
- **BRO-3429** ("P1: dispatch watchdog redispatches only through bsc-next, so
  every Linear P0/P1 rescue silently fails") — a live session was working this;
  it is the SAME defect `dispatchArgvFor` already fixed and merged. Check for
  duplicated work before it lands a second implementation.
- **The 130 P1s.** Once f8516c52191 lands and the watchdog restarts, the drain
  should work them 6-wide continuously. WATCH IT: confirm claims carry `linear:`
  ids, not Notion numerics, and confirm the concurrency cap actually binds
  (`watchdogLiveCount` must count headless jobs — it does now, but verify).
- **Main is red** on Data Validation (sibling-title misroute, flag-vs-CV
  contradictions, stale `duplicateOf` breadcrumbs). Pre-existing since before
  16:35 UTC — NOT from this work. Partly covered by BRO-3357.

## Recipes

Restart the watchdog onto new code (it caches CAPS at module load):
```bash
kill -TERM $(pgrep -f "dispatch-watchdog.js --dashboard" | head -1)
# wait out the 10-min heartbeat staleness bar, then:
node scripts/dispatch-watchdog.js --ensure-tab
# it closes the dead tab and recreates it — no tab leak. Verify:
node -e 'console.log(require(process.env.HOME+"/.claude/state/dispatch-watchdog.json"))'
```

Check the drain is working the right board:
```bash
node scripts/dispatch-watchdog.js --status --json | grep -E 'p01Queued|writeBackLeak|holds|eligible'
grep -c '"event":"watchdog-redispatch","taskId":"linear:' data/audit/dispatch-ledger.jsonl
```

Dispatch one card by hand (never wrap in `timeout` — a hook blocks that):
```bash
node scripts/linear-next.js --id BRO-N --headless --detach
```
