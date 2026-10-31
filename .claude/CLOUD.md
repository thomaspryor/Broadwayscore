# .claude/CLOUD.md — read first if you're a cloud Claude Code session

Cloud sandboxes do not mount the owner's `~/.claude/`. `.claude/hooks/session-start.sh` installs the owner's global `CLAUDE.md` + `anti-slop-rules.md` from the private `thomaspryor/claude-config` repo at every cloud start; their "## Cloud sessions" section overrides Mac-only rules, and Mac-only blocks are stripped from the cloud copy (BRO-5072). Fetch failures are reported. See also `.claude/hooks/` and `cloud-memory/`.

## Before your first tool call

0. **Doctor (BRO-5892):** `node scripts/cloud-doctor.js --fix --quick` (also in a new worktree) checks and repairs data clones and copies, `node_modules`, REST dispatch, secrets and hooks. A clone "behind origin" WARN is normal.
1. **Verify secrets:** `node scripts/check-cloud-secrets.js`. Env vars are set only in the web UI: claude.ai/code → cloud icon with the environment's name → gear on the environment row → **Environment variables** (`KEY=value` per line). `LINEAR_API_KEY` is required (Tier 1): without it every board operation fails closed. Review texts need no token when the session has `broadway-review-texts` attached; `REVIEW_TEXTS_TOKEN` (fine-grained PAT, read on both data repos) is for single-repo sessions and routines, and is what makes the bootstrap clone review texts (`--all`, BRO-4729).
2. **Data bootstrap is automatic** in single-repo sessions: `cloud-bootstrap.sh` runs `scripts/cloud-bootstrap-data.sh` (token, then `gh`, then proxy clone; else a buildable STUB from `public/data/mobile-shows.json`), then gap-fills gitignored generated files (`cast-manifest.json`, `actor-slugs.json`, `video-reviews.json`, …) so `tsc` passes; with real data those are empty, so cast/actor/video features are degraded. No `data/shows.json`? Run `bash scripts/cloud-bootstrap-data.sh` and read its output.
3. **Read accumulated learnings:** `cat cloud-memory/MEMORY.md` (a curated subset). Find any note: `grep -i <topic> cloud-memory/INDEX.txt` (one line per note; generated, never hand-edit), or `grep -ril <term> cloud-memory/`. It is a mirror of the Mac's memory: an edit to `cloud-memory/MEMORY.md` is overwritten by the Mac's next sync (`scripts/lib/cloud-memory-merge.js` NEVER_ADOPT) and a note deleted only here is re-copied. Edits to other notes are adopted.
4. **Coordinator:** before your first edit and each land, run `node scripts/coordinator-check.js --card BRO-N` and put its `COORDINATOR-ACK:` line in your commit.

## Project hooks that fire in cloud (project-scoped subset)

Each is a copy of a `~/.claude/hooks/` master and self-skips when `$HOME/.claude/hooks/<basename>` exists, so the Mac runs the master. About 25 of ~40 Mac hooks do not fire in cloud; follow those by hand from the global instructions. In multi-repo sessions they fire only through the setup-script install (see below).

- `session-start.sh`: critical-rules banner + integrity check.
- `verify-edits.sh` (Stop): blocks "done" without Bash verification; needs a closing verdict line: `SAFE TO ARCHIVE — <why>`, `KEEP OPEN — <what it waits on, what wakes it>` or `ACTION NEEDED FROM YOU — <what>` (a DECISION NEEDED / `You need to:` ask pairs only with ACTION NEEDED); blocks an unmerged PR with no blocker (`CI still running`, `CI red`, merge conflict, `DECISION NEEDED:`, `PR-BLOCKER: <reason>`); NOCARD blocks work with no Linear card (`NO-CARD: <reason>`); INFLIGHT blocks SAFE TO ARCHIVE while a background Agent or self-bound Routine is pending; OPENWORK, LOOSEENDS, WAKELESS, CLEARCLOSE, OWNERMERGE and LANDUNCHECKED block hand-offs, offers, a `KEEP OPEN` with nothing armed to wake it, an unclear closing block, "waiting on your merge" and a land push with no run check (`BACKLOG-OK: <why>`). Bypass `NO-VERIFY: <reason>`.
  - Finish chain: SAFE TO ARCHIVE after edits under `src/`, `scripts/`, `.claude/hooks/`, `.github/workflows/` or `supabase/` needs a review since those edits (`/ship-check`, `/code-review`, or `/second-opinion` while the session has ≤15 code edits; up to 8 fixup edits after it are covered until the owner's next message), then `/what-else` and `/wrap-up` (NOWRAPUP also checks the wrap-up's Linear close-out). Only real invocations count (the Skill tool or the owner typing the slash command), not an Agent called "review", a codex call, or doing it by hand. Edits through Bash count. Bypasses `NO-SHIP-CHECK:` / `NO-WHAT-ELSE:` / `NO-WRAP-UP: <reason>` (`NO-VERIFY:` does not waive the review); kill switch `CLOUD_CHAIN_GATE_DISABLE=1`.
- `github-main-guard.sh`: refuses GitHub MCP writes to Broadwayscore `main` and MCP PR creates/merges/auto-merge; land via `land/<name>`. Override `LAND_ENFORCE_OFF=1` or `$HOME/.claude/LAND_ENFORCE_OFF`.
- `block-resend-broadcasts.sh`: refuses direct `resend.com/broadcasts` calls (CLAUDE.md §17).
- `bulk-dispatch-loop-guard.sh`: warns on uncapped dispatch loops.
- `infra-plan-review-gate.sh` + `infra-post-write-audit.sh`: CLAUDE.md §18. An edit to shared infrastructure (scope: `scripts/lib/infra-review-scope.js`) is blocked until `/second-opinion` or `/plan-review` ran and `node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass --session-id=$CLAUDE_CODE_SESSION_ID` recorded it. Escape `NO-PLAN-REVIEW: <reason>`; kill switches `INFRA_REVIEW_GATE_DISABLE=1` / `INFRA_POST_AUDIT_DISABLE=1`.
- `cloud-bootstrap.sh` (SessionStart, cloud-only): the data bootstrap above.
- `worktree-enforce.sh`: hard-blocks tracked-code edits outside a worktree (CLAUDE.md §1).
- `pre-push-visual-gate.sh`, `pre-push-review-gate.sh`, `pre-merge-review-gate.sh`, `check-skill-redaction.sh`: Bash gates on `git push`/`git merge` (visual QA, review, skill redaction; `pre-push-review-gate.sh` also refuses pushing `main`). `github-main-guard.sh` runs the visual gate on MCP writes (advisory, BRO-2394).
- `pre-push-land-preflight.sh`: see Landing.
- Review gates (BRO-5359): a cloud `land/*` push over 30 gated lines needs a real `/ship-check` with its reviewers (and `npm run build` for `src/`); the Stop hook refuses `SAFE TO ARCHIVE` after a hollow ship-check, did-it-work, what-else or early close-out. Rules: `scripts/lib/review-coverage.mjs`. Receipt (BRO-5411, advisory): after `/ship-check`, `node scripts/review-receipt.js stamp` before the land push; land.yml warns if missing.
- `enterworktree-guard.sh`: worktree name collisions only. `whitespace-nowrap-lint.sh`: CSS overflow warning.
- `block-prompting-remote-tools.sh` (cloud-only): `send_later`, `create_trigger`, `add_repo` prompt the owner's phone in every mode (`requiresUserInteraction`). It denies self-initiated scheduling and loop re-arms (wait in-turn with a background Bash loop or Monitor, or `subscribe_pr_activity`; ScheduleWakeup is best-effort), re-attaching Broadwayscore, and `list_sessions` (use `get_session` by id). Owner-requested reminders (`initiation: human_request`) and other repos pass. Kill switch `REMOTE_TOOL_BLOCKER_DISABLE=1`.

## Slash commands available in cloud

**If one fails with "Unknown skill"** (sessions started with `create_session`, intermittently): Read `.claude/commands/<name>.md` and follow it fully by hand. The Stop hook counts that read after the failed call, never the failed call, and refuses a `NO-SHIP-CHECK`/`NO-WHAT-ELSE`/`NO-WRAP-UP` whose reason is only that the command did not load (BRO-5068).

Only `.claude/commands/` in this repo (`ls .claude/commands/`). The planning suite (`/plan-review`, `/right-problem`, `/plan-tasks`) is committed here; its Codex/Gemini legs fall back to Claude agents when those CLIs/keys are absent.

## Landing (the owner never merges)

A finished change is yours to land, same session, no asking:

1. Run the CLAUDE.md §12 checks in your worktree, then `git push origin HEAD:refs/heads/land/bro-N-<slug>`. The card in the name lets the hourly stranded pass (BRO-4802) re-run evicted refs and route refusals to it. If git push is refused: `mcp__github__create_branch` with `land/<name>`, or dispatch `land.yml` with `branch=land/<name>` (the full `land/…` name). A commit message with `[skip ci]` gets no push-triggered run: dispatch `land.yml` by hand.
   - `pre-push-land-preflight.sh` (BRO-4593) previews the land rebase and test registration on every `git push … land/*` and blocks with the fix. Fix the branch, never route around it. New tests need no manifest edit; `scripts/verify-*` probes need `OPT_IN` in `scripts/lib/unit-test-collection.js`. Land rebases and drops merge commits, so squash: `git fetch origin main`, merge `origin/main`, `git reset --soft origin/main`, commit once.
   - **Parked (BRO-6015):** `wait-for-land.js` saying "parked in the landing line" means the queue is full; the sweep resumes oldest first. Re-run the waiter; never re-push under a new `land/` name, hand-retry, or cancel a mutex-waiting run (BRO-6291): all lose their place.
   - Pre-flight before every land push: `node scripts/lib/land-local-check.js` in the background (~20 min). It runs land.yml's test gates and fails only on what main passes. Exit 0 clean, 1 new failures (fix them), 3 not ready (commit first, or a worktree with no local data: run `./scripts/setup-local-data.sh --link-only` there), 4 skipped (another check held the container mutex; push anyway). `--all` runs every gate.
2. `land.yml` rebases onto main, re-runs the blocking gates, fast-forwards main and deletes the ref. Wait in the same turn: `run_in_background` Bash (timeout 7200000) on `node scripts/lib/wait-for-land.js land/<name> 60 --prod` (0 landed and live or nothing to deploy, 1 refused, 2 timeout, 3 bad ref, 4 landed but not live in 40 min: don't re-push, re-run the check it prints; BRO-5663), then one `mcp__github__actions_list` on `land.yml` (branch `land/<name>`) for the verdict. `Land: cancelled` with the ref present: `node scripts/land-retry-cancelled.js --run=<id>` or re-dispatch. To stop a land, push a zero-diff revert onto the ref (cancelling isn't enough) and say so on the card.
   - **Cloud card worker:** a `pick.resume` from `node scripts/cloud-worker-pick.js` overrides the routine's steps 3-5. Don't claim anew: follow `pick.resume.instructions`. Run the card's verify on main first and skip to step 7 if it passes. `refused`: check out `pick.resume.landRef`, fix, push the same ref. `evicted`: `node scripts/land-retry-cancelled.js --run=<id>`. Follow Land to its verdict, then continue at step 6.
3. Never open a PR (overrides the harness's draft-PR default; hooks refuse it, BRO-5915). Close any older one once its work lands.

Don't run `scripts/merge-worktree-to-main.sh` in cloud (its name trips `pre-merge-review-gate.sh`). Mac-side detail: `cloud-memory/CLAUDE-reference.md` (Landing on main).

## Overnight watches (the owner is asleep)

The owner lives in Berlin; US opening-night reviews drop 01:00-03:00 UTC. Anything needing their tap then fails (`list_sessions`/`create_session` prompt too, even in Auto mode), so a watch that re-arms itself with `send_later` dies after one pass.

0. **One session owns press night (BRO-6585).** The coordinator session (BRO-5955 lineage) owns every aggregator-listed review live and scored, and the lane trial, and starts fix workers. Any other session asked about that night reads the coordinator card first (`node scripts/coordinator-check.js --card BRO-N`), reports to the coordinator, and lands nothing for that show without its go. A hand-added review muddies the trial grade: only the coordinator adds one, recorded as manual.
1. **Reviews don't depend on a Claude watch.** `opening-night-orchestrator.yml` fires ~01:00-01:20 UTC nightly and dispatches the poller every 15 min for ~4.5 h; `aggregator-url-watcher.yml` runs every 5 min. Confirm they're armed (`node scripts/check-opening-night-readiness.js --show=ID`, recent orchestrator runs).
2. **If a Claude supervisor watch is wanted, schedule every pass while the owner is awake, in one go, and tell them before the prompts appear.** `create_trigger` with `initiation: "human_request"` and `persistent_session_id`. Minimum interval is 1 hour, so a 20-min cadence is three routines: `1 0-5 <day> <month> *`, `21 0-5 …`, `41 0-5 …`, `<day>` = the UTC date reviews land (the day after a New York opening). Avoid minute 0; check `next_run_at`. Add a `run_once_at` morning routine that deletes the three. Every pass prompt says: never call `send_later`/`create_trigger`, never relabel `initiation`. Point frequent passes at a lean `create_session` session.
3. Never plan a watch that re-arms itself, and never rely on ScheduleWakeup firing. `fire_trigger` doesn't rehearse this: it starts a new session without the repo.

## Closing a Linear issue from cloud

- **Cite the landed commit:** `PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/<sha>)`, sha from `git log origin/main` (land rebases). A prod URL alone is refused.
- **Live check without VERCEL_TOKEN:** `node scripts/check-prod-deploy.js <sha>` (one-shot; exit 0 live, 1 not yet, 2 unknown; `--wait`/`--json` still need the token; can't see a dashboard rollback).
- **A card that needs the owner's call** starts with `DECISION NEEDED: <plain-English question>`, then options and your recommendation. That line emails the owner and stops workers taking the card; "needs owner approval" wording never reaches the owner. Whoever acts on the answer deletes it. Emailing the owner: `docs/owner-email-guidelines.md`. **Owner answered in chat? Record it:** `node scripts/record-owner-answer.js BRO-N --choice A|B|own --text "<words>"` (its own question only). Visual ask shipped another way: `--choice void`.
- **Board status questions:** show the `node scripts/board-report.js --markdown` table, never hand-built categories. Read a card before saying it waits on the owner (BRO-6411).
- **RECHECK-AFTER probe tests** (red by design until their date) go in EXEMPT_NEVER_CI in `scripts/audit-orphan-tests.js` AND carry a skip-until guard in the file (`{ skip: Date.now() < CHECKABLE_FROM && '...' }`) or a `RECHECK-GREEN-TODAY: <why>` line: an unguarded red probe refuses your landing (BRO-5937).
- **Close out last**, after your last commit/push. A `--force` close is recorded as a `DONE-GATE-BYPASS:` line on the issue.

## Worktrees and branches in cloud

- Make worktrees with `git worktree add`; `EnterWorktree` can stall on an approval nobody answers (BRO-5033).
- **Core data in cloud is a disposable copy** (BRO-5217): `data/*.json` are plain copies of the private core-data clone, re-copied at each session start (`data/.core-data-sha`), never symlinks, so reading them needs no permission prompt. Edits to them are lost; data changes go through approved-fix plans (`data/pending-fixes/`, below). The shows.json and retired-id writers refuse a cloud copy (`BSC_ALLOW_CLOUD_COPY_WRITE=1` for a throwaway scratch run). Never write into the clone (`~/broadway-scorecard-data`) or through a leftover `data/` symlink. Kill switch for the copies: `BSC_CLOUD_DATA_SYMLINK=1`.
- **Data in a new worktree:** `./scripts/setup-local-data.sh --link-only` sets up `data/*.json` (copies in cloud) and `data/review-texts` without fetching. Without it `tsc` and data tests fail for unrelated reasons.
- **Audits:** `validate-data.js` is `--dry-run` in cloud (`--write` to write). Run all-show audits with `run_in_background`, or `--show=<id>`.
- **Never `git checkout -B <branch>` for a branch another checkout has checked out** (git moves it silently). Push to `land/<name>` from your own branch or a detached HEAD.

## Owner one-time setup (cloud environment → Edit → Setup script)

Cached setup runs after cloning, before Claude (BRO-5221/6126):

```
for d in /home/user/Broadwayscore /home/user/broadwayscore; do [ -d "$d/.git" ] && git -C "$d" fetch -q origin main && git -C "$d" merge -q --ff-only origin/main; done; for d in /home/user/*/; do [ -f "$d/scripts/install-home-claude-config.js" ] && CLAUDE_CODE_REMOTE=true node "$d/scripts/install-home-claude-config.js" --adopt-hookless-settings; done; true
```

It cannot change auto mode (BRO-5008). When it refuses an owner-requested action, say so plainly and offer the nearest allowed route (a `land/<name>` branch, a dispatched workflow, a Linear card).

## Owner's investor figures (confidential)

Producers' figures from the owner's Broadway investments (capitalization, weekly budgets, returns) live in the private core-data clone under `private/` (see `private/README.md`; CI copies only repo-root `*.json`, so no build sees it). Use them to train and test the recoupment model. Never put a figure on the site, in Linear, a PR, a commit, an artifact, a CI log or this repo; a public number changes only when a public source supports it. New figures go in `private/`, pushed to the clone directly (the one exception to the next section).

## Fixing private data (review-texts, core data) from cloud

Don't clone and push the private repos. Route the edit through CI (BRO-4216):

**Field edits: generate the plan.** `node scripts/new-fix-plan.js --id=bro-N --summary="..." --edit='<showId>.<field>=VALUE' --review-edit='<show>/<file>.json:<field>=VALUE'` (`--help` for more). It fills `oldValue`, splits at 25 actions, runs preflight, force-adds the files and prints the step 3 command. Otherwise:

1. Write `data/pending-fixes/bro-N.json` by hand: shape and every action type (review-field-edit, review-file-op, data-edit, add-commercial-entry, retire-show, drop-orphan-key, retitle-show, add-show, ingest-html-handoff for a page CI can't fetch) are in `scripts/pending-fix-actions.md`.
2. `node scripts/lib/preflight-review-fix-plan.js <plan>` (replays data-edits, so a stale `oldValue` fails here), `git add -f` the plan, then land (`land/<name>`).
3. After the land is on main: `node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=bro-N -f plan_id=<planId> -f mode=apply --wait` (exit 0 = applied). It pushes the private repos (no owner email for `bro-*` plans: report in chat and Linear). Red if any action was refused.
4. The next rebuild picks it up (or dispatch `rebuild-fast.yml`).

Never put review text or reader contact details in a plan: the file is public.

## GitHub work in cloud (no `gh` CLI by default)

CLAUDE.md's `gh` runbooks don't run as written; use the GitHub MCP tools (secret rotation stays on the Mac). Probe first (BRO-4595): with the agent proxy, `gh` may be preconfigured (`curl -sS "$HTTPS_PROXY/__agentproxy/status"`) and REST works (`gh api user`, `gh run list/view`, `gh workflow run --ref main`; without `--ref` it needs GraphQL and fails); GraphQL is blocked, so use REST routes instead of `gh pr list`/`gh issue view`. Job logs: `curl` `actions/jobs/<id>/logs` into a file. Dispatch and wait: `node scripts/cloud-dispatch.js <workflow.yml> -f k=v --wait`. Monitoring: a `run_in_background` loop on the public API, never ScheduleWakeup alone.

**Bulk dispatches (BRO-6532):** loop llm-ensemble-score, ingest-urls or gather-reviews dispatches only through `node scripts/capped-workflow-dispatch.js`; stop on exit 3.

## Multi-repo sessions (BRO-5008, BRO-5221)

Several repos attached, or a misspelled `create_session` source_url, start the session in `/home/user`: `--add-dir` loads commands, never hooks. The setup-script line (below) runs `scripts/install-home-claude-config.js`, which wires every hook into `/home/user/.claude` and links `commands/`, `skills/`, `agents/`; startup repairs drift. Check with its `--check`.

If that reports DRIFT or nothing, no hooks fire: run `bash scripts/cloud-bootstrap-data.sh` first, then follow the hook rules by hand (no `POST /broadcasts/{id}/send`, no MCP writes to `main`, review before landing, close the card, canonical `create_session` URL).

`--adopt-hookless-settings` preserves unmarked, hookless settings, including permissions and `autoMode`, across install and uninstall.

## Production API keys from a phone session

The environment has PostHog, Sentry and Supabase keys (read+write): `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` (us.posthog.com), `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`, `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_` key; the `apikey` header), `SUPABASE_ACCESS_TOKEN` (Management API, project-scoped) + `SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Scraper, Resend, Bing, Impact, Formspree keys are set; no GA4 or Anthropic key. `node scripts/cloud-run-script.js [--review-texts] [--timeout=MIN] scripts/<x>.js [args...]` dispatches `run-script.yml`, runs the script as on origin/main with read keys, and prints its sealed output. Without `gh`, use `mcp__github__actions_run_trigger` (`script`, `args_json`, `pubkey_b64` from `generateKeyPair()` in `scripts/lib/sealed-output.js`, `request_id`) and `open()` the sealed block from `get_job_logs`. Paywalled: `scripts/fetch-page-probe.js`. Land scripts first. Data changes use `execute-approved-fix.yml` or their own workflows. Withheld: VERCEL_TOKEN, logins, cookies.

## Opening-night lane switch (BRO-6622)

Lane variables 403 in cloud: dispatch `opening-night-lane-switch.yml` (`set`/`clear` `LANE_ONLY_MARKETS`|`LANE_STANDDOWN`, or `rollback`), `mode` `dry-run` first, then `live`. Steps: `docs/opening-night-lane-switch-runbook.md`.

## Phone or Mac?

The owner is mostly on iPhone/iPad. Before saying something needs "the Mac":

- **Phone browser is enough** (give a direct link, never say Mac): GitHub settings (secrets, token scopes), ScrapingBee, Bright Data, Vercel and Supabase dashboards, Gmail filters (desktop-site mode), claude.ai/code environment settings, Routines.
- **Cloud can do it**: committed scripts with production keys (`cloud-run-script.js`), any workflow dispatch, private data edits (`execute-approved-fix.yml`), starting work in its own session (`create_session`).
- **Really the Mac**: outlet cookie renewal (The Stage, WSJ), the Mac's checkout and launchd jobs, cmux, WhatsApp/iMessage/Apple Reminders. Owner's hands only: task email (`docs/owner-email-guidelines.md`, BRO-6654).

## Key gaps cloud has vs local

| Capability | Cloud | Local |
|---|---|---|
| Live memory dir | NO, read the `cloud-memory/` mirror | YES (auto-loaded) |
| `~/.claude/commands/`, `~/.claude/skills/` | NO, only the repo's `.claude/` copies | YES |
| Local `.env` | NO, use `cloud-run-script.js` | YES |
| `bsc-next.js --id` cmux dispatch | NO, use `create_session` | YES |

## When in doubt

Do what you can from cloud first. Work a Mac session can do alone: `--dispatch --mac-only "<why>"` (`linear-brain.js --help`). Else say so in a line, keep going. Never ask the owner to switch to a local session or make a technical choice.

## Starting a worker session (BRO-5040)

"Queued for the worker" is never a finish line (owner, 2026-10-11). Anything important (a P0/P1, a bug they raised, a fix your work turned up) gets its own session now:

1. File or claim the card first; it carries the handoff and a safe-form `VERIFY:` line. File it `--child "BRO-N: <short>"` (BRO-6359): In Progress and claimed, so no worker takes it (`--dispatch` gets built twice). If `create_session` fails, move it back to Todo.
2. **Model (BRO-5228):** always pass `model` from `node scripts/session-model.js BRO-N ...` (`--no-card` without one); omitted, it inherits your Opus (a hook blocks it). Mixed batch: Sonnet; Opus cards go to an Opus subagent.
3. `create_session` with `source_url: "https://github.com/thomaspryor/Broadwayscore"` (exact spelling), `title: "BRO-N: <short>"`, `tags: ["bro-n"]` and a self-contained prompt: the card id and what done means; claim via `linear-session.js claim`; worktree via `git worktree add`, never `EnterWorktree`; land via `land/<name>`, follow the run, re-run VERIFY on main, close it; a line `BUDGET: <1-12>h` (usually 6h): at the budget it lands what's done, reports, files the rest, ends; a line `REPORT-BACK:` (BRO-5781): last, `send_message` `@parent` card, outcome, run URL; never call `create_session`, `send_later` or `create_trigger`; never end a turn waiting on CI: poll in-turn (BRO-6264); if a skill is "Unknown", follow `.claude/commands/<name>.md` (BRO-5068).
4. Tell the owner in one line what you started.
5. If you still need its result here: end your turn; its report-back or a failure event wakes you (no polling or `send_later`). BLOCKED (unanswered prompt): `interrupt_session`, `send_message` a workaround. FAILED: fix or restart. Silent at BUDGET+30 min: `send_message` it to wrap up; never `interrupt_session` mid-land.
6. **Once it runs and owns the work end to end, SAFE TO ARCHIVE is fine** (BRO-5881): it lands and verifies its own work. If you must act on its result, or the change is high-risk, end `KEEP OPEN — <what you wait on>` (its report-back wakes you; BRO-6020); say in plain words what it is doing and your next step.

**Owner questions (BRO-5385, BRO-6539):** before asking, run `node scripts/lib/owner-decision-recall.js "<topic>"` (it stands) and `decision-restate.js BRO-N` (answered: act, never restate). A recommended option with a safe default and no money, irreversible step, outbound email or public claim is decided and recorded (`docs/owner-escalation.md`). A child session sends owner questions to its parent (`send_message` `@parent`), never ends with a question list. Work needing a new session: a child asks its parent to start it, or files a START-NOW card (below).

**No human in the session** (a routine, the board worker, a child you started): never `create_session`. File the card with a `START-NOW:` line: `node scripts/linear-brain.js create "<title>" --dispatch --priority 2 --notes "START-NOW: <why it should not wait> ..."`. The board worker (`scripts/cloud-worker-pick.js`, every 2 hours) takes START-NOW Todo cards filed 10 minutes to 48 hours ago first; `linear-brain.js create` refuses one with no safe VERIFY. If `linear-session.js claim` prints `"action": "noop"` for a card that was Todo when picked, another worker took it; stop.

**Plain backlog** (can wait weeks): a normal card, ending with a `BACKLOG-OK: <why it can wait>` line.

**Cost ledger (BRO-5671, BRO-6504):** a session with `get_session` records itself at wrap-up: `get_session` with no id, save it to a file, `node scripts/record-claude-session-cost.js --from-json=<file> --cards=BRO-N`, commit `data/audit/claude-session-cost.jsonl` (feeds the digest's "Claude cost, 7 days").
