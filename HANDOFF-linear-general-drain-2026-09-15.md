# 👑 Handoff: build the Linear-native general P1 drain (owner asked for it twice)

You own this end-to-end. Independently re-verify every claim below — a prior
session's "done" is a hypothesis, mine included. If your context fills, repeat
this crowned-handoff pattern: write a fresh handoff file, launch and crown your
own successor via `launchCmuxSession` (`scripts/lib/cmux-launch.js`), title
starting "👑 OWNER — ".

## The owner's instruction, verbatim

> "Otion A obviously. Though i feel like I've answered this at least once
> already, so make sure it hasn't been done already. But also do B now sure"

and, when asked to choose between A and B: **"Both are needed"**.

They are right that they answered twice — they first said "Yes restart the P1
triage robot" and got a question back instead of delivery. Do not ask again.
Build it.

## What is already DONE — do NOT redo

- **(B) is done.** `com.broadwayscore.linear-drain-parked` is loaded and
  `enabled` (verified: `launchctl print-disabled gui/$(id -u)` reports
  `=> enabled`). Ticks 10:30/14:30/18:30 local (NOT 10/14/18 — I misread it at first). Undo with
  `launchctl unload -w ~/Library/LaunchAgents/com.broadwayscore.linear-drain-parked.plist`.
- **The rule-18 plan review has RUN** and is recorded as **`--result=fail`**
  in `.claude/review-verdicts.jsonl`. Read the findings below before writing a
  line of code. A fail verdict stands until an `owner-override`; your redrawn
  plan needs its own `record-plan` pass verdict before your first edit to
  `scripts/lib/**` or the dispatch layer.
- **"Has it been done already?"** — checked, and no. No general Linear drain
  exists on any branch, on origin/main, or as a Linear card. Only the narrow
  `linear-drain-parked`. `backlog-drain.js` is the Notion original and is dead:
  it reads `~/.claude/tasks/broadwayscore/`, 123 tasks, **zero** `linear:` ids,
  all `[notion:...]`, and Notion has been read-only since 2026-08-30.

## The plan I wrote, and why it FAILED review

My plan was: add `mode: 'parked' | 'general'` to `selectDrainCandidates` in
`scripts/lib/linear-drain-parked.js`, add `--mode=general` to the CLI, add a
second plist at 11/15/19, install it unloaded.

Five reviewers ran (Codex production+architecture, pre-mortem, Gemini
consistency, code-design; the structure/devil's-advocate lens was still running
when I handed off and its scratch output dies with my session — treat it as
lost and re-run that lens if you want it).

### P0 #1 — the predicate reinvents a module written because THIS drain failed

`isGeneralBacklogCandidate` (state in {unstarted, backlog} + priority in {1,2}
+ not auto-filed + no PARKED_SENTINEL) duplicates
`classifyHeadlessDispatchability` in `scripts/lib/headless-dispatchability.js:229`.
That module's five `BLOCKERS` (`:105`) are `PARKED_SENTINEL`, `VISUAL_QA_GATE`,
`ASYNC_WAIT_GATE`, `OWNER_DECISION_GATE`, `NO_VERIFY_CMD`. My filter hand-rolls
ONE and drops THREE. Its header is a postmortem of the general backlog drain
going **0-for-4 and burning $14.74** on sessions that finished work they could
not land — UI cards stuck at the visual-QA gate, cards waiting on a cron.
Those are exactly what a "P1/P2 Todo, not auto-filed" filter selects.
`scripts/backlog-drain.js:56,547` already calls it. My plan reverted a fix.

### P0 #2 — circular require

`headless-dispatchability.js:49` already does
`require('./linear-drain-parked.js')` for `AUTO_FILED_MARKER` and builds
`ALERT_ROUTER_PARKED_RE` at module scope from it (`:60`). Importing it back
into the selector closes a cycle -> `undefined.replace(...)` under one load
order. The cycle is the design saying the general predicate does not belong in
the leaf selector.

### P0 #3 — the guard waivers are hardcoded (I verified this myself)

`scripts/linear-drain-parked.js:399`:
`dispatchFn(..., { allowAutofixFiled: true, allowAutomationParked: true })`.
Any general mode plumbed through that call site inherits BOTH waivers. Worse,
`AUTO_FILED_MARKER` at `scripts/lib/linear-drain-parked.js:36` is
`'Auto-filed by owner-alert-router'` — a DIFFERENT string from
`autofix-filed-marker.js`'s `'Auto-filed by digest-autofix'`. So a "not
auto-filed" test written with `isAutoFiledParked` lets every digest-autofix
`BSC Daily:` tracker through **and then waives the guard that exists to refuse
them**. Line 353's park/reconcile loop also gates on `isAutoFiledParked`, so a
repeatedly-failing general card would never park — it re-selects every tick,
forever.

### Two premises of my plan were simply FALSE — verify these yourself first

1. **`--mode=general` does not parse.** `parseArgs` does `const k = t.slice(2)`
   (`scripts/linear-drain-parked.js:~128`), so `--mode=general` yields the key
   `mode=general`. The flag would silently no-op and parked mode would run
   under a general label. Confirmed by reading the function.
2. **This drain has NO spend circuit breaker and NO aggregate live-job cap.**
   `grep -cE "spend|breaker|circuit" scripts/linear-drain-parked.js` -> **0**.
   The same grep on the disabled `scripts/backlog-drain.js` -> **17**. My plan
   said "reuse the existing spend breaker unchanged"; there is nothing to
   reuse. `:363` caps each selection only; `scripts/lib/bsc-runner.js:9`'s
   lease is per-task, not aggregate. **You must build admission accounting
   before any second schedule is enabled.**

### Other findings worth acting on

- `scripts/lib/linear-dispatch.js:903` builds the open-issues query **without
  `priority`** — a priority filter has nothing to filter on until you add the
  field. Selector fixtures with invented priorities will hide this.
- `.github/workflows/check-linear-drain-health.yml:65` requires **more than
  three** candidates, but the drain selects at most three — the existing health
  check can never fire. Monitoring is already broken; fix before ramping.
- Dry-run is not read-only: `scripts/linear-drain-parked.js:337` still appends
  reconciliation outcomes.
- Two refusals park a card (`scripts/lib/attempt-memory.js:122`), and a
  lease-held refusal counts as `card-fail` (`:254`) — so infrastructure
  refusals silently park urgent work. Distinguish infra refusal from real
  failure.
- Dispatch precedes the journal append (`:399`), so a crash between them loses
  attempt history; `dispatch-reconcile.js:119` matches the earliest subsequent
  spawn by task/time, so per-mode attempt namespaces alone cannot stop
  cross-mode mis-attribution. Namespace the dispatch-ledger taskId per mode.

## The redrawn plan the design reviewer proposed (start here)

1. Keep `scripts/lib/linear-drain-parked.js` **mode-free**. Change the
   signature to inject the predicate, matching this repo's own precedent
   (`scripts/lib/backlog-drain.js:110` `candidateOrder(tasks, {parkedIds,
   refusedNotionIds, inFlightIds, notionIdOfFn})` varies by injection, never by
   a mode string; and in this codebase `mode` is an OUTPUT — `claude-cli.js:249`,
   `linear-dispatch.js:202` — not an input):
   `selectDrainCandidates(issues, { isEligible = default, rank = issueNumberRank, limit, alreadyAttempted })`.
   Existing callers stay byte-identical, no new import, no cycle.
2. Compose the general predicate **in the CLI**, which may freely require
   `headless-dispatchability.js` exactly as `linear-next.js:99` already does:
   `isEligible: (iss) => PRIORITY.has(iss.priority) && STATES.has(iss.state.type) && classifyHeadlessDispatchability({subject: iss.title, notes: iss.description}).dispatchable`.
   That inherits all five blockers forever instead of re-deriving one.
3. Rank with `sortIssuesByPriority`/`priorityRank` from
   `scripts/lib/linear-dispatch.js:155-170` — do not hand-roll priority order.
4. Make the guard waivers mode-conditional; pass them only for the parked mode.
5. Gate the park loop on the mode's own predicate, not `isAutoFiledParked`.
6. Fix `parseArgs` to accept `--mode=general` (or use a positional), and
   **reject unknown modes loudly** rather than defaulting to parked.
7. Add the aggregate spend/live-job admission accounting that does not exist.
8. Ramp: fix dry-run to be genuinely read-only, run it, count candidates — if
   it selects more than ~20 the filter is wrong — then `--cap 1` against the
   real drain, then hand the owner the enable command. Install the plist
   UNLOADED.

## Acceptance

`node --test tests/unit/linear-drain-parked.test.mjs` (705 lines, already
exists; add a case that a custom `isEligible` is honoured, and keep the default
path as a regression pin).

## Ground rules

1. Record a fresh `record-plan` **pass** verdict before your first edit to
   `scripts/lib/**` or the dispatch layer — the current recorded verdict is
   `fail` and the hook will block you.
2. Worktree before any tracked code edit.
3. Never trust a subagent verdict — re-run the command yourself.
4. `/ship-check` then `/wrap-up` before you call it done.
5. This machine is at high swap pressure and ~20 concurrent sessions. Prefer
   `ScheduleWakeup` over long-lived background jobs.

## Everything else from my session is FINISHED — do not reopen

- In Review backlog: **120 -> 29 real**, 91 closed, every close carrying an
  acceptance command I re-ran myself against a pinned fresh origin/main.
  Urgent 8 -> 0.
- Root cause filed on **BRO-3037**: 40 cards carried acceptance commands naming
  test files that never existed (`enrich-card-acceptance.js` validated only the
  parent directory), so the Done gate could never pass and
  `linear-session.js:246-250` left them parked forever.
- Shipped on origin/main (3 commits, ship-check clean): the "Review queue"
  digest block — `scripts/lib/in-review-backlog.js`, `scripts/bsc-in-review.js`,
  a `send-morning-digest.js` section, 25 tests, a `test.yml` push path.
- **BRO-3376** is closed.
- Still open and needing the OWNER, not you: **BRO-2960** (re-opened to Todo,
  breaker state persists 6x/24h on an hourly cron), **BRO-296**, **BRO-184**
  (belongs in the iOS repo), **BRO-275**.
- **BRO-221** is verified test-ready; the owner has the exact recipe
  (`CALENDAR_EXPORT_ENABLED=1 NEXT_PUBLIC_FEATURES=userAccounts,calendarExport
  npx next dev -p 3777`, then `/my-shows?mock=1&tab=watchlist`). They have not
  run it yet. Do not turn the flag on in production for them.

## Known-red main, not yours

Two pre-existing failures, both owned elsewhere: a good-news ratchet in
`tests/unit/dispatcher-safety-port-table.test.mjs` (owned by the live
workspace:245 "🤖⚡ Loop·BRO-3373 P1: autonomous-acceptance-recheck.js only")
and `scripts/lib/non-review-url-patterns.test.mjs` (carded as **BRO-3398**).
Judge your work on whether IT is green, never on whether main is.

## SIXTH REVIEWER (arrived last, is the most important — it MEASURED the funnel)

It ran the numbers against the live board (1,230 open issues) instead of
reasoning about them. Re-verify these yourself, but they are specific:

**The live funnel:** 1,230 open -> 693 P1/P2 -> 546 Backlog/Todo -> 514 not
auto-filed-parked -> **356 with a safe command** -> **110** after the parked
sentinel and the autofix guard. So the pool is 110, not "a few".

- **140 of the 356 are refused by `autofixFiledIssueGuard`** (`linear-dispatch.js:544`,
  enforced `linear-next.js:645`) — named examples BRO-3268, BRO-3302, BRO-3301.
  So either general mode waives that guard (and double-dispatches against a
  second pipeline) or it eats 140 silent refusals.
- **246 of the 356 carry `PARKED_SENTINEL_RE`** (`headless-dispatchability.js:93`),
  and **106 of those are OWNER-parked, not automation-parked**
  (`isAutomationParked`, `:216`) — so `--allow-automation-parked` does not
  rescue them.
- **26 of the surviving 110 carry headless blockers** (VISUAL_QA_GATE 15,
  ASYNC_WAIT_GATE 7, OWNER_DECISION_GATE 4). Each is refused at
  `linear-next.js:941-977` with no spawn, orphans at 3h, records `card-fail`,
  and **two ticks later is permanently parked by `checkPark` (maxFailures=2)
  with a reason that is a lie.**
- **Priority-then-age puts the WORST cards first.** The head of the sorted pool
  is BRO-43, BRO-73 (a RECHECK-AFTER date gate), BRO-80, BRO-244 ("Decide: is
  TodayTix actually the prize…"). They are stale precisely because they need
  owner judgment. The ramp's first impressions would be its worst ones.
- **The dumbest failure mode:** the top of the general pool is the dispatch
  layer itself (BRO-2951, BRO-3535, BRO-3413, BRO-3438 "Raise DISPATCH_CAP
  3->8"). An unattended session edits gated infra, `infra-plan-review-gate.sh`
  blocks it mid-run, the session dies, two ticks later the card is parked.
  **The drain eats the work that would fix the drain.**
- **My tick offsets were wrong.** The parked plist ticks **10:30/14:30/18:30**,
  not 10/14/18. And non-overlapping ticks mitigate nothing anyway: dispatches
  are detached and long-lived, `dispatchDetached` staggers only 45s within one
  tick (`:399`), so an 11:00 general tick spawns 3 sessions while 10:30's 3 are
  still running — no global cap, swap-pressured box, racing the same
  `git worktree add` lock (`digest-autofix.js:405-411`).
- **Naming:** a mode flag makes six things lie — the filename, module header,
  log prefix `[linear-drain-parked]`, `linear-drain-parked-ledger.jsonl`, the
  `drain-parked-dispatch` event, the plist name and the CI workflow. The honest
  third option is extracting the tick into `scripts/lib/drain-core.js` with an
  injected selector — itself a rule-18 refactor.
- **Ledger attribution is missing entirely:** rows are
  `event:'drain-parked-dispatch'` (`:401`) with no mode field, all in one file
  (`:95`). Post-hoc you cannot tell which drain dispatched what. Separate
  ledger files break `recentlyAttempted` across modes (same issue dispatched by
  both inside the 6h cooldown, `:114`); one shared file lets a general failure
  park a parked-mode card. Both are wrong as stated.

## THEREFORE: DO NOT BUILD T1-T4 FIRST

Two independent reviewers reached the same restructure conclusion, and it is
the single most important line in this document:

> Zero code change gets the same lesson. Run `node scripts/linear-next.js --list`,
> hand-dispatch **3** issues with `--id BRO-N`, and read the outcomes.

Do that first. If 3 of 3 hand-dispatches produce real merged work, then write
T1. If they do not — and the funnel above suggests they will not — the drain
was never the right answer and you have learned it for the price of three
sessions instead of a fortnight of unattended spend.

Two things must be fixed before ANY code lands regardless:
1. `priority` is not in `buildOpenIssuesWithDescriptionsQuery`
   (`scripts/lib/linear-dispatch.js:903-920` selects
   `identifier,title,description,url,state` only), so a priority filter reads
   `undefined` for all 1,230 issues and selects zero. Widening that query
   touches `listOpenIssuesWithDescriptions` (`linear-client.js:335`), used by
   owner-alert-router's dup-search — shared infra, rule 18.
2. The 140-issue guard overlap above.
