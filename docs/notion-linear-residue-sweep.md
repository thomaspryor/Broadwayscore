# Notion → Linear residue sweep (BRO-3018)

Swept 2026-10-05: `scripts/`, `src/`, `.github/workflows/`, `~/.claude/hooks/`,
`~/Library/LaunchAgents/` (plist CONTENTS, not names), prompt text.
Guard: `scripts/tests/notion-live-write-paths.test.mjs` (scanner:
`scripts/lib/notion-residue-scan.js`). It strips comments first, fails on any
file outside its allowlist that gains a Notion channel (SDK write, raw
`api.notion.com`, `notion-brain.js create|update`, or the repo's own Notion
helpers), and fails on stale allowlist entries. Registered in `test.yml` and
`tests/unit-test-manifest.txt`.

Of the 388 files that mention "notion", 25 have a live code channel. Rest is comments.

## A. Still references the old world (25 files with a live channel)

| File | Verdict | Notes |
|---|---|---|
| `scripts/notion-brain.js` | chokepoint | create exits 6 (`notion-write-guard.js`); update deliberately ungated so old cards can close |
| `scripts/lib/notion-writes.js` | chokepoint | the one `pages.update` helper |
| `scripts/lib/notion-create-safety.js` | chokepoint | post-create check, reached only via notion-brain create |
| `scripts/notion-action-poll.js` | dead | its launchd job is disabled (`.disabled-2026-08-30`) |
| `scripts/autonomous-merge.js`, `scripts/autonomous-run.js`, `scripts/autonomous-triage.js` | dead | autonomous loop retired 2026-07-27; `autonomous-merge.yml` is dispatch-only |
| `src/app/api/autonomous-action/route.ts` | additive-deadend, LIVE | the 7:30am morning digest's signed "Dispatch a fix" button (`send-morning-digest.js`, `dispatch-link.js`) creates a Notion card for the disabled poller: owner taps, nothing happens. **Filed BRO-4718 (dispatched)** |
| `scripts/audit-archived-in-progress.js`, `scripts/audit-orphan-inprogress.js` | dead | no scheduler, only `test.yml` |
| `scripts/notify-pending-commercial-notion.js`, `scripts/sync-pending-review-to-notion.js` | dead | workflows call the `-linear` twins |
| `scripts/bsc-prune.js`, `scripts/bsc-reconcile.js`, `scripts/reconcile-dead-completions.js`, `scripts/notion-tasks-sync.js` | mirror-update | live launchd; local task store → Notion card UPDATES, never creates. See C |
| `scripts/enrich-card-acceptance.js` | mirror-update | Notion leg was live daily via `card-verifiability-audit.yml`. **Fixed**: workflow now `--source linear` |
| `scripts/freeze-ledgers.js`, `scripts/lib/stuck-work.js` | read-only | list/get/query only |
| `scripts/bsc-next.js`, `scripts/linear-brain.js`, `scripts/lib/dispatch-guards.js` | text-only | hint/refusal strings naming the legacy command |
| `src/lib/notion-api.ts`, `src/app/api/feedback/route.ts`, `src/app/api/submit-review/route.ts` | additive-deadend | public site still creates a Notion page per submission (Formspree / GitHub issue are the real consumers). **Filed BRO-4717** |

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
| `sync-pending-review-to-notion.js` | 6 | throws `FATAL`, non-zero | dead, loud |
| morning-digest dispatch button (route.ts) | 0 (HTTP 200) | creates a Notion card nobody reads: silent | filed BRO-4718 |
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
- `predispatch-queue-audit` (launchd) audits that same task store via
  `notion-brain get`: audits the legacy queue, not Linear. Dormant-by-source.
- `reconcile-dead-completions` (launchd): same mirror. Dormant-by-source.
- `health-check.js` row "Data: undispatchable backlog cards" reads the
  Notion-only `card-verifiability.json`, which nothing now shrinks. Filed in BRO-4717.

## D. Capability gaps

| Gap | Status |
|---|---|
| No status-read verb in `linear-brain.js` | **Fixed**: `linear-brain.js get BRO-N` prints state name/type and `terminal` |
| Three terminal state types | Already centralized in `scripts/lib/linear-state-types.js` (`TERMINAL_STATE_TYPES`); a sweep of `nin:` filters and hardcoded literals found every query uses it. `reclassify-headless-endings.js` checks only `completed` on purpose ("done") |
| iOS Claude Code sessions cannot reach Linear | Owner fixed on the Linear side; not re-verifiable from this Mac CLI, noted here only |
| Hooks only understand Notion ids | BRO-2470 |

## Not covered

`~/.claude/hooks/**` content audit (BRO-2470); Notion Brain data itself;
`.github/actions/**` has no live channel.
