# Notion → Linear residue sweep (BRO-3018)

Swept 2026-10-05: `scripts/`, `src/`, `.github/workflows/`, `~/.claude/hooks/`,
`~/Library/LaunchAgents/` (plist CONTENTS, not names), prompt text.
Guard: `scripts/tests/notion-live-write-paths.test.mjs` (scanner:
`scripts/lib/notion-residue-scan.js`). It strips comments first, fails on any
file outside its allowlist that gains a Notion channel (SDK write, raw
`api.notion.com`, `notion-brain.js create|update`, or the repo's own Notion
helpers), and fails on stale allowlist entries. Registered in `test.yml` and
`tests/unit-test-manifest.txt`.

Of the 388 files that mention "notion", 25 had a live code channel at the sweep; 18 remain
(BRO-4717/4718 removed the four site-side ones on 2026-10-12). Rest is comments.

## A. Still references the old world (18 files with a live channel after 2026-10-14)

| File | Verdict | Notes |
|---|---|---|
| `scripts/notion-brain.js` | chokepoint | create exits 6 (`notion-write-guard.js`); update deliberately ungated so old cards can close |
| `scripts/lib/notion-writes.js` | chokepoint | the one `pages.update` helper |
| `scripts/lib/notion-create-safety.js` | chokepoint | post-create check, reached only via notion-brain create |
| `scripts/notion-action-poll.js` | dead | its launchd job is disabled (`.disabled-2026-08-30`) |
| `scripts/autonomous-merge.js`, `scripts/autonomous-run.js`, `scripts/autonomous-triage.js` | dead | autonomous loop retired 2026-07-27; `autonomous-merge.yml` is dispatch-only |
| `scripts/audit-archived-in-progress.js`, `scripts/audit-orphan-inprogress.js` | dead | no scheduler, only `test.yml` |
| ~~`scripts/notify-pending-commercial-notion.js`, `scripts/sync-pending-review-to-notion.js`~~ | deleted 2026-10-14 | workflows call the `-linear` twins |
| `scripts/bsc-prune.js`, `scripts/bsc-reconcile.js`, `scripts/notion-tasks-sync.js` | mirror-update | live launchd; local task store → Notion card UPDATES, never creates. See C |
| `scripts/enrich-card-acceptance.js` | mirror-update | Notion leg was live daily via `card-verifiability-audit.yml`. **Fixed**: workflow now `--source linear` |
| `scripts/freeze-ledgers.js` | read-only | list/get/query only (`lib/stuck-work.js` deleted 2026-10-14 with the digest rows) |
| `scripts/bsc-next.js`, `scripts/linear-brain.js`, `scripts/lib/dispatch-guards.js` | text-only | hint/refusal strings naming the legacy command |

Removed from the list on 2026-10-12 (no Notion channel left, so no longer allowlisted):

- `src/app/api/autonomous-action/route.ts`: the morning digest's signed "Fix this" tap
  (`send-morning-digest.js`, `dispatch-link.js`) now files a Linear issue in Todo with the
  router's `[conditionKey:...]` anchor and a safe-form acceptance command
  (`src/lib/linear-dispatch-issue.js`), and shows an error page when `LINEAR_API_KEY` is
  missing. Its approve/reject/revert paths (Notion `Auto` cards, only ever linked by the
  retired nightly loop's `autonomous-email.js`) were removed; old links get a 410 page. **BRO-4718**
- `src/lib/notion-api.ts`, `src/app/api/feedback/route.ts`, `src/app/api/submit-review/route.ts`:
  the per-submission Notion page write was deleted (Formspree / the GitHub issue were the real
  consumers). `isMalformedFeedbackPayload` moved to `src/lib/feedback-form-validation.js`. **BRO-4717**

Prompt/seed text: `scripts/opening-night-prompts/monitor-v2.md` told the
opening-night monitor to create a Notion card (exit 6). **Fixed** (Linear
instructions). `bsc-conductor.js`, `weekly-retro.sh`, `what-else.md`,
`ship-check.md`, `did-it-work.md`, `wrap-up.md` already say Linear.
`scripts/lib/plan-refusal-escalation.js` header still described a Notion create;
**fixed** (the code path was already Linear).

`~/.claude/hooks/` (private repo, covered by BRO-2470, not edited here):
`notion-card-required-stop/commit`, `notion-create-verify/block`,
`exit-status-gate`, `session-start` are all registered in `settings.json`; the
only `notion-brain` mentions in `exit-status-gate.sh`/`session-start.sh` are
comments/rule text. Plists whose CONTENTS mention notion:
`reconcile-dead-completions`, `predispatch-queue-audit`, `hook-liveness`: see C.

## B. Breaks under the new rules (non-zero exits)

| Caller | Exit seen | What it does | Verdict |
|---|---|---|---|
| `generate-remediation-plan.js` | was 6 | already files to Linear (BRO-3430/377) | fixed earlier |
| `posthog-friction-analyzer.js`, `ux-walkthrough.mjs`, `commercial-*-notify` | was 6 | already moved to Linear | fixed earlier |
| `sync-pending-review-to-notion.js` | 6 | throws `FATAL`, non-zero | deleted 2026-10-14 |
| morning-digest dispatch button (route.ts) | 0 (HTTP 200) | created a Notion card nobody reads: silent | **fixed** (BRO-4718): files a Linear issue; 500 page if `LINEAR_API_KEY` is missing |
| `monitor-v2.md` prompt | 6 | the LLM would hit exit 6 and (maybe) skip the outcome | **fixed** |
| `card-verifiability-audit.yml` enrich | n/a | not an exit failure: silent LLM spend on a frozen board | **fixed** |
| `enrich-card-acceptance.js --source linear` when the Linear fetch fails | 0 | `runLinearLeg` returned `[]`, job exited 0, so an outage was silent | **fixed**: fetch and getTeam failures now return a `failed` row so `allFailed()` exits 1 (still masked under `--source both` if the Notion leg enriched a card; workflow no longer uses `both`) |

No fail-soft `notion-brain.js create` caller remains: `notion-write-paths-retired.test.mjs`
(BRO-3430) covers swallowed exits, and the new scan covers every channel.

## C. Machinery pointing at a retired source

- `bsc-reconcile.js reconcileTaskSessions()` reads `~/.claude/tasks/<list>` (the
  local task store, fed by `notion-tasks-sync.js`). The store is still written
  by live sessions but no longer mirrors a live board. Linear orphans are covered
  separately by its Linear-'started' zombie sweep (BRO-3925), `dispatch-watchdog`,
  `check-linear-drain-*`. Verdict: live but narrowed; no change.
- `predispatch-queue-audit` (launchd): **Fixed BRO-5845** — the per-task Notion
  card fetch is gone; the predispatch tally is Linear-only, the frozen mirror
  feeds only the dispatch-guard tally (card = null).
- `reconcile-dead-completions` (launchd): **Fixed BRO-5845** — the Notion card
  correction + sync-map pushed-flag reset were removed; it reopens local tasks
  and Linear issues only.
- `health-check.js` row "Data: undispatchable backlog cards" read the
  Notion-only `card-verifiability.json`, regenerated daily from the frozen mirror.
  **Retired** (BRO-4717): only the Linear rows (`card-verifiability-linear.json`) remain,
  and `card-verifiability-audit.yml` no longer runs the `--source notion` audit (BRO-3488).

## D. Capability gaps

| Gap | Status |
|---|---|
| No status-read verb in `linear-brain.js` | **Fixed**: `linear-brain.js get BRO-N` prints state name/type and `terminal` |
| Three terminal state types | Already centralized in `scripts/lib/linear-state-types.js` (`TERMINAL_STATE_TYPES`); a sweep of `nin:` filters and hardcoded literals found every query uses it. `reclassify-headless-endings.js` checks only `completed` on purpose ("done") |
| iOS Claude Code sessions cannot reach Linear | Owner fixed on the Linear side; not re-verifiable from this Mac CLI, noted here only |
| Hooks only understand Notion ids | BRO-2470 |

## Second pass, 2026-10-14: references to the retired scripts and the task mirror

The first pass guarded Notion WRITE channels. This pass swept every live
(comment-stripped) reference to `notion-brain.js`, `notion-tasks-sync.js`,
`notion-action-poll.js`, the task mirror (`TASKS_DIR`, `~/.claude/tasks`,
`loadNotionMirrorTasks`) and `NOTION_API_KEY` across `scripts/`, `src/`,
`.claude/hooks`, `.claude/commands`, `.claude/CLOUD.md`, `docs/cloud-routines`,
`.github/workflows` and `cloud-memory/`. 51 code files had a hit. Cluster cards
BRO-4717, BRO-3488, BRO-4718 and BRO-5072 were already Done on main.

### Fixed (cloud-reachable)

| Finding | What it did | Fix |
|---|---|---|
| `health-check.js` `checkStuckWork` | Daily digest read the frozen Notion board: 53 "stuck" cards on 2026-10-14, 48 with no exact Linear twin, most `BRO-N:` ones already Done/Canceled in Linear | Rows retired; `scripts/lib/stuck-work*.js` deleted. Linear covers both states: `linear-reclaim-abandoned.js` (hourly) and a paused report moves the card to Backlog (`lib/linear-session-reporting.js`). Snapshot below |
| `generate-remediation-plan.js` `escalatePlanRefusal` | After filing in Linear, ran `notion-tasks-sync.js pull` in CI | Removed |
| `lib/digest-autofix.js` `syncTasks` | Dead export that shelled `notion-tasks-sync.js pull` | Removed |
| `cloud-bootstrap-data.sh` `ensure_notion_client` | Every cloud session npm-installed `@notionhq/client` | Removed |
| `check-cloud-secrets.js`, `cloud-selftest.sh`, `CLOUD.md` | `NOTION_API_KEY` listed as required | Tier 2 / dropped (closes sprint-plan S5-T6) |
| 11 workflow steps (affiliate-link-integrity, audit-aggregator-gap ×2, check-push-ledger, data-health-check ×4, monitor-scheduled-email-count, rebuild-reviews, test.yml) | Passed `secrets.NOTION_API_KEY` to scripts that never read it; comments said the router shells to `notion-brain.js` (it files Linear) | Key and stale comments removed; `npm ci` steps kept with corrected reasons; `DEPENDENCIES.md` regenerated |
| `notify-pending-commercial-notion.js`, `sync-pending-review-to-notion.js` | Dead, workflows run the `-linear` twins | Deleted |

### Guards added

- `tests/unit/no-notion-secret-in-workflows.test.mjs` now fails on any workflow
  passing `secrets.NOTION_API_KEY` outside `autonomous-merge.yml` (and on a stale
  allowlist entry). Passes on the live tree, so arming it blocks nothing today.
- `scripts/audit-notion-schedule-coupling.js` (advisory, runs in
  `data-health-check.yml`, surfaces as a digest row) now also flags
  `notion-tasks-sync.js`, `notion-action-poll.js` and `loadNotionMirrorTasks` in
  any scheduled workflow's scripts. Its allowlist names each intentional case.
- The first pass's `notion-live-write-paths.test.mjs` still fails on any new
  Notion write channel.

### Recorded, not changed

| Files | Verdict | Why |
|---|---|---|
| `bsc-next.js`, `bsc-reconcile.js`, `bsc-prune.js`, `bsc-conductor.js`, `notion-tasks-sync.js`, `reconcile-dead-completions.js`, `predispatch-queue-audit.js`, `predispatch-check.js`, `lib/predispatch-guard.js`, `backlog-drain.js`, `dispatch-drift-watch.js`, `audit-mirror-status-drift.js`, `audit-close-time-verify.js`, `audit-card-relevance.js` (+lib), `archive-completed-tasks.js`, `gc-merged-worktrees.sh`, `lib/autofix-canary.js`, `lib/digest-autofix.js` (mirror read), `send-morning-digest.js` (mirror read) | Mac-only, moot | cmux/launchd dispatch world; the Mac fleet has made 0 dispatches in 7+ days (BRO-5168) |
| `linear-next.js` | Mac-only, intentional | mirror read is a cross-board collision guard (allowlisted in the coupling audit) |
| `notion-action-poll.js`, `autonomous-run/merge/triage/shadow-run/email.js`, `audit-orphan-inprogress.js`, `audit-archived-in-progress.js`, `recover-we-historical-s1-s2.mjs` | Dead | no scheduler (or launchd job disabled); `autonomous-merge.yml` is dispatch-only. Removal touches 45+ files each and buys nothing at runtime |
| `linear-import.js`, `migrate-import-ledger.js`, `freeze-ledgers.js`, `export/verify-notion-corpus.js` | One-shot migration tools | history |
| `enrich-card-acceptance.js`, `audit-card-verifiability.js` | Gated | Notion leg only under `--source notion`; the workflow passes `linear` |
| `notion-brain.js` | Chokepoint | create exits 6 |
| `lib/dispatch-guards.js`, `lib/dispatch-card-drift.js`, `claude-auth-preflight.js`, `rebuild-memory-index.js`, `local-triggers/weekly-retro.sh`, `.claude/hooks/session-start.sh`, `verify-edits.sh`, `docs/cloud-routines/weekly-retro.md`, `.claude/commands/*.md` | Text only | hint strings, or prose that forbids Notion |
| `.claude/hooks/notion-create-block.sh` | Dead, kept on purpose | unregistered; `cloud-settings-guards.test.mjs` keeps the file for old snapshots |
| `cloud-memory/*notion*` | History | only `linear-board-workflow.md` is indexed, and it says Notion is retired |
| `digest-audience.js` / `autonomous-email-render.js` "Stuck work" prefixes | Inert | match rows that no longer exist |

### Stuck-work snapshot at retirement (2026-10-14)

Frozen Notion cards the retired rows still counted that had no exact-title Linear
twin. Kept here as the one-time record instead of 48 new issues; many `BRO-N:`
ones were checked by id and are already closed in Linear.

| Bucket | Idle | Notion card title |
|---|---|---|
| paused P0/P1 | 58d | P1: ~20% of cmux dispatches die silently — chronic week-long rate nothing aggregates or al |
| paused P0/P1 | 57d | P1: nothing alarms when main has been red for hours — this session existed because of that |
| paused P0/P1 | 57d | reconcile-dead-completions leaves sync-map pushed:true, so a corrected card can never auto |
| paused P0/P1 | 56d | P1: tryout-venue review scores onto the transfer — no gate catches venue mismatch in URL s |
| paused P0/P1 | 56d | P1: fetchPage url_mismatch guard rejects legitimate site redirects, dropping WE aggregator |
| paused P0/P1 | 56d | P1: opening-night-poller burns 23m37s of its 60-min cap on checkout (fetch-depth:0 full-bl |
| paused P0/P1 | 56d | P0 #1199: dispatch dead-launch rate is now measured (20.5% over 7d) |
| paused P0/P1 | 56d | P1: update-show-status.yml runs keep ending CANCELLED — 3 of the last 4, cause unidentifie |
| paused P0/P1 | 56d | P1: submit-review-form ingests outlets with no registered domain; LLM then scores marketin |
| paused P0/P1 | 55d | P0: update-show-status.yml blocked 4 days by duplicate Sound of Music entry — kills ALL op |
| paused P0/P1 | 55d | P1: hourly gap audit dead 5h — push-with-retry disqualifies its own data/audit path from A |
| paused P0/P1 | 54d | Extend rate-limit-aware retry to push-core-data / push-review-texts / push-aggregator-arch |
| paused P0/P1 | 49d | P1: scraper.js never loads dotenv — all paid fetch tiers silently skipped in local runs |
| paused P0/P1 | 48d | P1: dedupe picks a survivor that a later gate excludes, loser never re-promoted |
| paused P0/P1 | 48d | P1: manual/auto review ingest leaves llmScore=null and nothing queues the file for scoring |
| paused P0/P1 | 48d | Wire 2 more CV self-heal wrongProduction/wrongShow clear sites onto isStaleScoreInput() (c |
| paused P0/P1 | 48d | cmux dead-launch rate: fix wrapper-detection false negative (#1812) |
| paused P0/P1 | 48d | P0: the cmux WORKSPACE lane is the only lane that dies — 115/368 dispatches (31%) never ru |
| paused P0/P1 | 48d | P1: scoring-delta.js has a blind spot for rebuild-all-reviews.js own inline exclusion loop |
| in progress | 82d | P1: cmux new-workspace terminals spawn NO shell process — all cmux dispatches broken (mach |
| in progress | 81d | P1: headless-claude fallback for the opening-night monitor launcher — cmux must be preferr |
| in progress | 57d | BRO-406: CANARY touch data/audit/canary-2026-08-17.marker |
| in progress | 56d | Opening night monitor: Jeeves Takes Charge (8/18 WE), Abigail's Party + Spellbound (8/19) |
| in progress | 55d | OWNER: BRO-343 crown v11 — P1 triage + dispatch loop (v10 handoff successor) |
| in progress | 55d | BRO-318: main test.yml STILL red — dedupe-same-url-bylines stale canonical pointer |
| in progress | 55d | BRO-51: CI Test Suite red on main since 2026-05-02 |
| in progress | 55d | BRO-115: Backfill excerpt-only unscored reviews (Linear is system of record) |
| in progress | 55d | domainMatchesExpected() unanchored substring match accepts unrelated domains |
| in progress | 54d | BRO-67: LLM fallback fires on PARTIAL extraction, not just zero |
| in progress | 54d | BRO-2238: Unit Tests red fleet-wide — invisible failing test |
| in progress | 53d | Fix data-health-check.yml digest snapshot push-race |
| in progress | 49d | P0: headless opening-night monitor runs without .env — every fetchPage() census dies |
| in progress | 24d | P0: tour-contamination safety net silently un-publishes LIVE Broadway reviews when their f |
| in progress | 24d | BRO-132: pre-send banner strip guard |
| in progress | 24d | Infra: sync reconcile-broadcast-state.js writes to origin (#1853) |
| in progress | 24d | P1: audit-aggregator-gap auto-ingest writes UNFLAGGED phantom reviews (no roundup detectio |
| in progress | 24d | P1: audit-duplicate-of-url-mismatch.js --fix reverts correct cross-domain duplicateOf (pro |
| in progress | 24d | P1: allowTourSignal / allowFilmSignal missing from PROTECTED_FIELDS — a CI restore can sil |
| in progress | 24d | Route remaining IBDB creativeTeam consumers through SERP verification (BRO-102 follow-up) |
| in progress | 24d | BRO-47: Column-count brittleness audit across table-parsing scrapers |
| in progress | 24d | BRO-86: Mezzanine override collision auditor |
| in progress | 24d | BRO-104: Health-digest warning triage — drive warnings to true-state-only |
| in progress | 24d | BRO-80: Triage unopened shows carrying scored prior-run reviews |
| paused other | 57d | Teach cv-wrongproduction-unhandled.check.js to recognize priorRuns coverage (cut 800+ fals |
| paused other | 56d | P2: bsc-next's own dispatch-refusal message tells you to add a VERIFY: line, but extractVe |
| paused other | 55d | BRO-70: Network-tier publishDate backfill |
| paused other | 48d | audit-time-bomb-tests.js exemptions are whole-file, not per-test — could mask a future rea |
| paused other | 24d | UX audit: In the Watchlist, the list view ('mobile__watchlist_list') provides a trash icon |

## Not covered

`~/.claude/hooks/**` content audit (BRO-2470); Notion Brain data itself;
`.github/actions/**` has no live channel.
