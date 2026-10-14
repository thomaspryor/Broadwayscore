# .claude/CLOUD.md — read first if you're a cloud Claude Code session

Cloud sandboxes (claude.ai/code, iOS, Mac desktop) don't mount the owner's `~/.claude/` (the Mac's hooks, slash commands and memory). `.claude/hooks/session-start.sh` installs the owner's global `CLAUDE.md` + `anti-slop-rules.md` from the private `thomaspryor/claude-config` repo at every cloud start (BRO-4237); their "## Cloud sessions" section overrides Mac-only rules, and Mac-only blocks are stripped from the cloud copy (BRO-5072). If the fetch failed, session-start printed a short owner fallback plus the reason. This file, `.claude/hooks/` and `cloud-memory/` cover the rest.

## Before your first tool call

1. **Verify secrets:** `node scripts/check-cloud-secrets.js`. Env vars are set only in the web UI: claude.ai/code → cloud icon with the environment's name → gear on the environment row → **Environment variables** (`KEY=value` per line, no quotes; visible to anyone with environment edit access). `LINEAR_API_KEY` is required (Tier 1): `linear-brain.js` needs it at session start and end, and without it every board operation fails closed. `NOTION_API_KEY` is optional (Tier 2): Notion is retired and no cloud work reads it. Review texts need no token when the session has `broadway-review-texts` attached (BRO-5008); `REVIEW_TEXTS_TOKEN` (fine-grained PAT, read on both data repos) is for single-repo sessions and routines, and is what makes the bootstrap clone review texts (`--all`, BRO-4729). The tokenless proxy clone fallback is unverified and may leave a STUB; without the token session start prints a WARN line and `data/review-texts` is absent.
2. **Data bootstrap is automatic** in single-repo sessions: `cloud-bootstrap.sh` runs `scripts/cloud-bootstrap-data.sh` (token, then `gh`, then proxy clone; else a buildable STUB from `public/data/mobile-shows.json`), then gap-fills gitignored generated files (`cast-manifest.json`, `actor-slugs.json`, `video-reviews.json`, …) so `tsc` passes; with real data those are empty, so cast/actor/video features are degraded. No `data/shows.json`? Run `bash scripts/cloud-bootstrap-data.sh` and read its output.
3. **Read accumulated learnings:** `cat cloud-memory/MEMORY.md` (a curated subset). Find any note: `grep -i <topic> cloud-memory/INDEX.txt` (one line per note; generated, never hand-edit), or `grep -ril <term> cloud-memory/`. It is a mirror of the Mac's memory: an edit to `cloud-memory/MEMORY.md` is overwritten by the Mac's next sync (`scripts/lib/cloud-memory-merge.js` NEVER_ADOPT) and a note deleted only here is re-copied. Edits to other notes are adopted.

## Project hooks that fire in cloud (project-scoped subset)

Each is a copy of a `~/.claude/hooks/` master and self-skips when `$HOME/.claude/hooks/<basename>` exists, so the Mac runs the master. About 25 of ~40 Mac hooks (e.g. design-system-lint) do not fire in cloud; follow those by hand from the global instructions. In multi-repo sessions they fire only through the setup-script install (see below).

- `session-start.sh`: critical-rules banner + integrity check.
- `verify-edits.sh` (Stop): blocks "done" without Bash verification; requires a closing `SAFE TO EXIT` / `NOT SAFE TO EXIT` line (SAFE TO EXIT means the owner may close or kill the session now); blocks an unmerged PR with no stated blocker (`CI still running`, `CI red`, a merge conflict, `DECISION NEEDED:`, or `PR-BLOCKER: <reason>`; a bare NOT SAFE TO EXIT or "waiting on review" does not count); NOCARD blocks work with no Linear card filed or claimed (`NO-CARD: <reason>`; it and the Linear close-out gate fail open when Linear is down); INFLIGHT blocks SAFE TO EXIT while a background Agent has not handed back or a self-bound Routine (`send_later`/`create_trigger` into this session) is still pending: collect, stop or delete it first, or end `NOT SAFE TO EXIT — <what is in flight>`; OPENWORK (BRO-5040) blocks it while a session you started has not been seen finished via `get_session`, or when the closing message hands work to the board worker (`BACKLOG-OK: <why it can wait>`); OWNERMERGE blocks "waiting on your merge" / "ready for your review" / "unreviewed"; LANDUNCHECKED blocks SAFE TO EXIT after a land push with no run check. General bypass `NO-VERIFY: <reason>`.
  - Finish chain (BRO-4238/4367): SAFE TO EXIT after edits under `src/`, `scripts/`, `.claude/hooks/`, `.github/workflows/` or `supabase/` needs a review since those edits (`/ship-check`, `/code-review`, or `/second-opinion` while the session has ≤15 code edits; up to 8 fixup edits after it are covered until the owner's next message), then `/what-else` and `/wrap-up` (NOWRAPUP also checks the wrap-up's Linear close-out). All missing steps are named in one block, and `NOT SAFE TO EXIT` is never blocked by it. Only real invocations count (the Skill tool or the owner typing the slash command), not an Agent called "review", a codex call, or doing it by hand. Edits through Bash (`sed -i`, `cat >`, python writes) count. Bypasses `NO-SHIP-CHECK:` / `NO-WHAT-ELSE:` / `NO-WRAP-UP: <reason>` (`NO-VERIFY:` does not waive the review); kill switch `CLOUD_CHAIN_GATE_DISABLE=1`. Each Stop check blocks at most once per turn-chain (cap 4), and one that already fired falls through to the next, so fixing one complaint never skips the rest.
- `github-main-guard.sh` (BRO-4238): refuses GitHub MCP writes to Broadwayscore `main` and MCP PR merges/auto-merge; land via `land/<name>`. Override `LAND_ENFORCE_OFF=1` or `$HOME/.claude/LAND_ENFORCE_OFF`.
- `block-resend-broadcasts.sh`: refuses direct `resend.com/broadcasts` calls (CLAUDE.md §17).
- `infra-plan-review-gate.sh` + `infra-post-write-audit.sh`: CLAUDE.md §18. An edit to shared infrastructure (scope: `scripts/lib/infra-review-scope.js`) is blocked until `/second-opinion` or `/plan-review` ran and `node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass --session-id=$CLAUDE_CODE_SESSION_ID` recorded it. Escape `NO-PLAN-REVIEW: <reason>`; kill switches `INFRA_REVIEW_GATE_DISABLE=1` / `INFRA_POST_AUDIT_DISABLE=1`.
- `cloud-bootstrap.sh` (SessionStart, cloud-only): the data bootstrap above.
- `worktree-enforce.sh`: hard-blocks tracked-code edits outside a worktree (CLAUDE.md §1).
- `pre-push-visual-gate.sh`, `pre-push-review-gate.sh`, `pre-merge-review-gate.sh`, `check-skill-redaction.sh`: Bash gates on `git push`/`git merge` (visual QA, review, skill redaction; `pre-push-review-gate.sh` also refuses pushing `main`). `github-main-guard.sh` runs the visual gate on MCP writes (advisory, BRO-2394).
- `pre-push-land-preflight.sh`: see Landing. Also the review gate for landing (BRO-5359): a `git push … land/*` of more than 30 gated lines (src, scripts, workflows) is refused until a real `/ship-check` has run its reviewers (a Claude review Agent, `review-panelist` preferred, AND an external reviewer: `curl` to api.openai.com or `codex exec`; plus `npm run build` when the diff touches `src/`, since land.yml runs tsc and lint but not the build) after the Skill call. A review that runs after landing can stop nothing, so run it first. The reviewers must be real: the Agent (any subagent type, since some containers lack `review-panelist`) needs a 200+ character review prompt that says to review the diff, and the external call must be a `curl -d` POST to a model endpoint (or `codex exec`) with a non-error response. `# NO-SHIP-CHECK: <reason, 15+ chars>` inside the push command bypasses it (logged to `.claude/land-preflight.jsonl`; a chat line does not reach this gate); `NO-LAND-PREFLIGHT` does not. Kill switches `SHIP_CHECK_LAND_GATE_DISABLE=1`, and `LAND_PREFLIGHT_DISABLE=1` turns off the whole hook including this gate. `/code-review` is trusted, not coverage-checked. Cloud only, fails open without a transcript.
- `stop-review-coverage.sh` (BRO-5359, repo-only): refuses `SAFE TO EXIT` after a `/ship-check` whose reviewers never ran (a bare Skill call is not a review). For any session with a `/ship-check` or `/code-review` run it also checks the rest of the chain for substance: `/did-it-work` ran and printed its TESTED block, `/what-else` printed all five LENSES lines and read the real roadmap (`mcp__github__issue_read` on broadway-scorecard-data issue 1, the closing message counts), and the Linear Done close-out came after the last `land/` push. Bypass lines: `NO-SHIP-CHECK:` / `NO-DID-IT-WORK:` / `NO-WHAT-ELSE:` / `NO-WRAP-UP: <reason, 10+ chars>`. Bypass: a `NO-SHIP-CHECK: <reason, 10+ chars>` line in the closing message. Kill switch `SHIP_CHECK_COVERAGE_DISABLE=1`. Blocks at most 3 times per session. Both gates share `scripts/lib/review-coverage.mjs`; `node scripts/lib/review-coverage.mjs --record` records the pass verdict only when coverage is complete.
- `enterworktree-guard.sh`: worktree name collisions only. `whitespace-nowrap-lint.sh`: CSS overflow warning.
- `block-prompting-remote-tools.sh` (cloud-only): `send_later`, `create_trigger` and `add_repo` prompt the owner's phone in every mode (`requiresUserInteraction`). It denies self-initiated scheduling and loop re-arms (wait in-turn with a background Bash loop or Monitor, or `subscribe_pr_activity`; ScheduleWakeup is best-effort), re-attaching Broadwayscore, and `list_sessions` (use `get_session` by id). Owner-requested reminders (`initiation: human_request`) and other repos pass. Kill switch `REMOTE_TOOL_BLOCKER_DISABLE=1`.
- `notion-create-block.sh`: retired and unregistered. Never use Notion; the board is Linear.

## Slash commands available in cloud

**If one fails with "Unknown skill"** (sessions started with `create_session`, intermittently): Read `.claude/commands/<name>.md` and follow it fully by hand. The Stop hook counts that read after the failed call, never the failed call, and refuses a `NO-SHIP-CHECK`/`NO-WHAT-ELSE`/`NO-WRAP-UP` whose reason is only that the command did not load (BRO-5068).

Only `.claude/commands/` in this repo (`ls .claude/commands/`). The planning suite (`/plan-review`, `/right-problem`, `/plan-tasks`) is committed here; its Codex/Gemini legs fall back to Claude agents when those CLIs/keys are absent.

## Landing (the owner never merges)

The owner does not review or merge PRs. A finished change is yours to land, same session, no asking:

1. Run the CLAUDE.md §12 checks in your worktree, then `git push origin HEAD:refs/heads/land/bro-N-<slug>`. The card in the name lets the hourly stranded pass (BRO-4802, `land-retry-cancelled.js --stranded`) re-run evicted refs and route refusals to the card. If git push is refused: `mcp__github__create_branch` with `land/<name>`, or dispatch `land.yml` with `branch=land/<name>` (the full `land/…` name). A commit message with `[skip ci]` gets no push-triggered run: dispatch `land.yml` by hand (BRO-4231).
   - `pre-push-land-preflight.sh` (BRO-4593) previews the land rebase and test registration on every `git push … land/*` and blocks with the fix. That is not a land refusal: fix the branch, never route around it. New tests need no manifest edit (BRO-2483 collector); the retired `tests/unit-test-manifest.txt` is ignored; `scripts/verify-*` probes need `OPT_IN` in `scripts/lib/unit-test-collection.js`. Land rebases and drops merge commits, so squash: `git fetch origin main`, merge `origin/main`, `git reset --soft origin/main`, commit once.
   - Optional full pre-flight: `bash scripts/lib/land-gauntlet.sh <scratchpad-dir>` (~16 min). Trust the exit codes of `tsc`, `tsc-llm-scoring`, `next-lint`, `scripts-lib-tests`, `unit-tests-tsx`, `bash-integration`; `unit-tests-node` exits 1 on origin/main too, so read its `not ok` names; `lint-workflows` needs actionlint (absent). It rewrites tracked `data/audit/*` and `data/gold-lists-computed.json`: `git checkout --` them before committing.
2. `land.yml` rebases onto main, re-runs the blocking gates, fast-forwards main and deletes the ref (cloud cannot delete refs; a superseded ref stays until a Mac session removes it, and the stranded pass treats it as a leftover once its card lands from another ref). Wait in the same turn: `run_in_background` Bash on `node scripts/lib/wait-for-land.js land/<name> 60` (exit 0 landed, 1 the run for your tip went red, 2 timeout, 3 typo'd ref; it waits through evictions), then one `mcp__github__actions_list` on `land.yml` for the verdict (LANDUNCHECKED counts only that). After a hand dispatch, check that run with `actions_list` too: wait-for-land sees the landing but a refusal only at timeout. A Land job may sit in "Wait for the landing mutex" for a while: that is the FIFO queue (BRO-5112), not a hang. `Land: cancelled` with the ref still present (rare since BRO-5112): `node scripts/land-retry-cancelled.js --run=<id>`, or re-dispatch. Never `send_later`/`create_trigger` for this.
   - **Cloud card worker:** a `pick.resume` from `node scripts/cloud-worker-pick.js` overrides the routine's steps 3-5 (BRO-4565). Don't claim anew: follow `pick.resume.instructions`. Run the card's verify on main first and skip to step 7 if it passes. `refused`: check out `pick.resume.landRef`, fix, push the same ref. `evicted`: `node scripts/land-retry-cancelled.js --run=<id>` (a skip means the sweep retries or the ref already moved on). Follow Land to its verdict, then continue at step 6.
3. Close any draft PR you opened after it lands (land rebases, so GitHub won't). Opening one is optional; this rule overrides the harness's draft-PR default.

Don't run `scripts/merge-worktree-to-main.sh` in cloud (its name trips `pre-merge-review-gate.sh`). Mac-side detail: `cloud-memory/CLAUDE-reference.md` (Landing on main).

## Overnight watches (the owner is asleep)

The owner lives in Berlin; US opening-night reviews drop 01:00-03:00 UTC. Anything needing their tap then fails (`list_sessions` and `create_session` prompt in practice too, Auto mode included), so a watch that re-arms itself with `send_later` dies after one pass.

1. **Reviews don't depend on a Claude watch.** `opening-night-orchestrator.yml` fires ~01:00-01:20 UTC nightly and dispatches the poller every 15 min for ~4.5 h; `aggregator-url-watcher.yml` runs every 5 min. Confirm they're armed (`node scripts/check-opening-night-readiness.js --show=ID`, recent orchestrator runs).
2. **If a Claude supervisor watch is wanted, schedule every pass while the owner is awake, in one go, and tell them before the prompts appear.** `create_trigger` with `initiation: "human_request"` and `persistent_session_id`. Minimum interval is 1 hour, so a 20-min cadence is three routines: `1 0-5 <day> <month> *`, `21 0-5 …`, `41 0-5 …`, `<day>` = the UTC date reviews land (the day after a New York opening). Avoid minute 0 (re-anchored to the creation minute); check `next_run_at`. Add one `run_once_at` morning routine that deletes the three by id. Every pass prompt says: never call `send_later`/`create_trigger`, never relabel `initiation`. Point frequent passes at a lean session started with `create_session`; keep at most a few passes on the long-running session.
3. Never plan a watch that re-arms itself, and never rely on ScheduleWakeup firing. `fire_trigger` doesn't rehearse this: it starts a new session without the repo.

## Closing a Linear issue from cloud

- **Cite the landed commit:** `PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/<sha>)`, sha from `git log origin/main` (land rebases). A prod URL alone is refused.
- **Live check without VERCEL_TOKEN:** `node scripts/check-prod-deploy.js <sha>` (one-shot; exit 0 live, 1 not yet; `--wait`/`--json` still need the token; can't see a dashboard rollback).
- **A card that needs the owner's call** starts with `DECISION NEEDED: <plain-English question>`, then options and your recommendation. That line emails the owner (`scripts/notify-owner-decisions.js`) and stops workers taking the card; loose wording like "needs owner approval" blocks workers but never reaches the owner. Whoever acts on the answer deletes it.
- **Close out last**, after your last commit/push. A `--force` close is recorded as a `DONE-GATE-BYPASS:` line on the issue (BRO-4241).

## Worktrees and branches in cloud

- Make worktrees with `git worktree add`; `EnterWorktree` can stall on an approval nobody answers (BRO-5033).
- **Core data in cloud is a disposable copy** (BRO-5217): `data/*.json` are plain copies of the private core-data clone, re-copied at each session start (`data/.core-data-sha`), never symlinks, so reading them needs no permission prompt. Edits to them are lost; data changes go through approved-fix plans (`data/pending-fixes/`, below). The shows.json and retired-id writers refuse a cloud copy (`BSC_ALLOW_CLOUD_COPY_WRITE=1` for a throwaway scratch run). Never write into the clone (`~/broadway-scorecard-data`) or through a leftover `data/` symlink. Kill switch for the copies: `BSC_CLOUD_DATA_SYMLINK=1`.
- **Data in a new worktree:** `./scripts/setup-local-data.sh --link-only` sets up `data/*.json` (copies in cloud) and `data/review-texts` without fetching. Without it `tsc` and data tests fail for unrelated reasons.
- **Never `git checkout -B <branch>` for a branch another checkout has checked out** (git moves it silently). Push to `land/<name>` from your own branch or a detached HEAD.

## Owner one-time setup (cloud environment → Edit → Setup script)

The setup script runs after the clones, before Claude starts, cached across sessions. It needs this line (BRO-5221):

```
for d in /home/user/*/; do [ -f "$d/scripts/install-home-claude-config.js" ] && node "$d/scripts/install-home-claude-config.js"; done; true
```

It cannot change auto mode: the classifier reads `autoMode` only from user, managed or `--settings` sources, and a session cannot read or edit its own settings (BRO-5008). When the classifier refuses an owner-requested action, say so plainly and offer the nearest allowed route (a `land/<name>` branch, a dispatched workflow, a Linear card).

## Fixing private data (review-texts, core data) from cloud

Don't clone and push the private repos. Route the edit through CI (BRO-4216):

1. Write `data/pending-fixes/bro-N.json`: `issueNumber: "bro-N"`, fresh `planId` (uuid), `status: "pending"`, `submitter: {name: null, email: null}`, `plan: {summary, steps, riskLevel, actions}`. Actions:
   - review text field: `{type: "review-field-edit", file: "<showId>/<file>.json", field, oldValue, newValue, description}`. Allowlist in `scripts/lib/review-field-edit.js`; `oldValue` must equal the current value. `url` only as a repair (BRO-4430): the current url must be an aggregator/round-up page, a non-review page, or another critic's review a sibling file holds; `newValue` is the outlet's own review url or `""` for an aggregator url on a Theatre Record text. Model: `data/pending-fixes/bro-4430.json`. Moves/deletes: `{type: "review-file-op", operation: "delete"|"move", sourcePath, destPath}`. Bring back a deleted file (text stays out of the plan): `{type: "review-file-op", operation: "restore", sourcePath, fromCommit: "<40-char review-texts sha>[^]", destPath?}` (`scripts/lib/review-file-restore.js`; model `data/pending-fixes/bro-5133-c.json`).
   - shows.json / commercial.json field: `{type: "data-edit", ...}` (allowlist `scripts/lib/feedback-pipeline-fields.js`; commercial `showSlug` is the shows.json slug; absent field → `oldValue: null`).
   - new commercial.json entry for a Broadway show with none: `{type: "add-commercial-entry", slug: "<shows.json slug>", entry: {designation, sources: [{type, url, date}], ...}}` (`scripts/lib/commercial-entry-action.js`: slug-keyed only, cited sources required, same per-record checks as validate-data.js; a non-TBD outcome is stamped `humanReviewedDesignation`). Model: `data/pending-fixes/bro-4627.json`.
   - remove a junk or duplicate row: `{type: "retire-show", id, expectTitle, reason, blockTitleVenue?, duplicateOf?}` (`scripts/lib/retire-show-action.js`: only `provisional: true` rows, or with `duplicateOf` a same-title same-house duplicate with zero reviews (id-only), or with `nonProduction: true` + `evidenceUrl` (https venue listing) an announced/upcoming never-opened row with zero reviews, e.g. a cinema screening or one-night event (BRO-4449); `expectTitle` must match; writes the retired-id registry + archive; `blockTitleVenue: true` only for junk that must never return under any id, never for a duplicate). Model: `data/pending-fixes/bro-4398.json`.
   - drop a stale audience-buzz key: `{type: "drop-orphan-key", file: "audience-buzz.json", showId, reason, renameTo?}`.
   - cosmetic title repair (case, punctuation, a trailing slug counter; id/slug unchanged): `{type: "retitle-show", id, expectTitle, newTitle, reason}` (`scripts/lib/retitle-show-action.js`). Model: `data/pending-fixes/bro-4505.json`.
   - new shows.json entry: `{type: "add-show", show: {...}, crossLinkFrom?}` (`scripts/lib/add-show-action.js`: refuses an existing id/slug, placeholder venues and unknown fields; `crossLinkFrom` also appends a `priorRuns` link on that existing show; `priorRunOf: "<earlier run id>"` instead puts the link on the NEW entry, for a return engagement). Same-title reruns: `<slug>-off-broadway-<year>`. Art in `public/images/shows/<id>/` lands with the plan. Model: `data/pending-fixes/bro-4259.json`. Then dispatch `gather-reviews.yml` with `shows=<id>`.
2. `node scripts/lib/preflight-review-fix-plan.js <plan>`, then land (`land/<name>`).
3. Dispatch `execute-approved-fix.yml` (`mcp__github__actions_run_trigger`) with `issue_number=bro-N`, `plan_id=<planId>`, `mode=apply`. It applies and pushes the private repos (no owner email for `bro-*` plans: report in chat and Linear). Red if any action was refused.
4. The next rebuild picks it up (or dispatch `rebuild-fast.yml`).

Never put review text or reader contact details in a plan: the file is public.

## GitHub work in cloud (no `gh` CLI by default)

CLAUDE.md's `gh` runbooks don't run as written; use the GitHub MCP tools (secret rotation stays on the Mac). Probe first (BRO-4595; decide by `gh api user` and `ToolSearch mcp__github`, since one session had no `mcp__github__*` tools at all): with the agent proxy, `gh` may be preconfigured (`curl -sS "$HTTPS_PROXY/__agentproxy/status"`) and REST works (`gh api user`, `gh run list/view`, `gh workflow run`) even though `gh auth status` says the token is invalid; GraphQL is blocked, so use REST routes instead of `gh pr list`/`gh issue view`. No `--jq`. Job logs: `curl` the API's `actions/jobs/<id>/logs` redirect into a file and slice it. Monitoring: a `run_in_background` loop on the public API (works without a token) or one `get_workflow_run` per turn, never ScheduleWakeup alone.

## Multi-repo sessions (BRO-5008, BRO-5221)

Several repos attached, or a misspelled `create_session` source_url, start the session in `/home/user`: `--add-dir` loads commands, never hooks. The setup-script line (below) runs `scripts/install-home-claude-config.js`, which wires every hook into `/home/user/.claude` and links `commands/`, `skills/`, `agents/`; startup repairs drift. Check with its `--check`.

If that reports DRIFT or nothing, no hooks fire: run `bash scripts/cloud-bootstrap-data.sh` first, then follow the hook rules by hand (no `POST /broadcasts/{id}/send`, no MCP writes to `main`, review before landing, close the card, canonical `create_session` URL).

## Production API keys from a phone session (BRO-5008)

The environment has no scraper, PostHog, GA4, Sentry or Anthropic keys, and the owner should not paste them (BRO-4622). `node scripts/cloud-run-script.js [--review-texts] [--timeout=MIN] scripts/<x>.js [args...]` dispatches `run-script.yml`, runs the script as on origin/main with read/analysis keys, and prints its output (encrypted to a per-run key) and exit code. Land a new script first. Nothing is pushed and written files are discarded, so data changes still go through `execute-approved-fix.yml` or their own workflows. Not available on purpose: RESEND, VERCEL_TOKEN, Supabase management keys, outlet logins and cookies. Check for a dedicated workflow first (`analyze-traffic-sources.yml`, `posthog-adhoc-query.yml`).

## Phone or Mac? (BRO-5008)

The owner works from the iPhone/iPad most of the time. Before saying something needs "the Mac" or "your computer":

- **Phone browser is enough** (give a direct link, never say Mac): GitHub settings (secrets, token scopes), ScrapingBee, Bright Data, Vercel and Supabase dashboards, Gmail filters (desktop-site mode), claude.ai/code environment settings, Routines.
- **Cloud can do it**: committed scripts with production keys (`cloud-run-script.js`), any workflow dispatch, private data edits (`execute-approved-fix.yml`), starting work in its own session (`create_session`).
- **Really the Mac**: outlet cookie renewal (The Stage, WSJ), the Mac's checkout and launchd jobs, cmux, WhatsApp/iMessage/Apple Reminders. Batch these into one short list.

## Key gaps cloud has vs local

| Capability | Cloud | Local |
|---|---|---|
| Live memory dir | NO, read the `cloud-memory/` mirror | YES (auto-loaded) |
| `~/.claude/commands/`, `~/.claude/skills/` | NO, only the repo's `.claude/` copies | YES |
| Bright Data / Browserbase scrapers | YES if secrets uploaded | YES |
| Local `.env` | NO, use `cloud-run-script.js` | YES |
| Repo hooks in multi-repo sessions | Only via `install-home-claude-config.js` in the setup script | YES |
| `claude-sync` for `~/.claude` | NO | YES |
| `bsc-next.js --id` cmux dispatch | NO, use `create_session` | YES |

## When in doubt

Do what you can from cloud first: most "local-only" things have a cloud route (GitHub MCP for `gh`, `land/<name>` for merging, `execute-approved-fix.yml` for private data, `create_session` for cmux dispatch). If something truly needs the owner's Mac, say so in one plain line and keep going. Never ask the owner to switch to a local session or to make a technical choice they can't evaluate.

## Starting a worker session (BRO-5040)

Owner 2026-10-11: "Trigger sessions yourself." The board worker's queue is weeks deep, so "queued for the worker" is never a finish line. Anything important that comes up while the owner is here (a P0/P1, a bug they raised, a fix your work turned up) gets its own session now:

1. File or claim the card first; it carries the handoff and a safe-form `VERIFY:` line.
2. **Model (BRO-5228):** pass `model` from `node scripts/session-model.js BRO-N ...` (`--no-card` without one); omitted, it inherits your Opus. Mixed batch: Sonnet; Opus cards go to an Opus subagent.
3. `create_session` with `source_url: "https://github.com/thomaspryor/Broadwayscore"` (exactly that, capital B; lowercase starts in /home/user with no commands or hooks, BRO-5068), `title: "BRO-N: <short>"`, `tags: ["bro-n"]` and a self-contained prompt: the card id and what done means; claim it with `linear-session.js claim`; make the worktree with `git worktree add`, never `EnterWorktree`; land via `land/<name>`, follow the run, re-run VERIFY on main, close it; never call `create_session`, `send_later` or `create_trigger`; if `/ship-check`, `/what-else` or `/wrap-up` fails with "Unknown skill", Read `.claude/commands/<name>.md` and follow it by hand (BRO-5068). Several independent cards get several sessions (soft cap ~8).
4. Each `create_session` may put an approval tap on the owner's phone; tell them in one line what you started.
5. Follow it with `get_session` every 20-30 min, not in a tight loop. BLOCKED usually means an unanswered permission prompt: `interrupt_session`, then `send_message` a workaround. FAILED means fix or restart it.
6. **SAFE TO EXIT only after its work is verified**: `get_session` shows COMPLETED or REVIEW_READY and you re-ran its VERIFY on origin/main yourself. With two or more sessions, also check the combined result after the last one lands. Until then: `NOT SAFE TO EXIT — <which session is doing what, and how you will check it>`. OPENWORK enforces this (in multi-repo sessions only once the setup-script install is in place).

**No human in the session** (a routine, the board worker, a child you started): never `create_session`. File the card with a `START-NOW:` line: `node scripts/linear-brain.js create "<title>" --dispatch --priority 2 --notes "START-NOW: <why it should not wait> ..."`. The board worker (`scripts/cloud-worker-pick.js`, every 2 hours) takes START-NOW Todo cards filed 10 minutes to 48 hours ago first; `linear-brain.js create` refuses one the picker would skip (no safe VERIFY). If `linear-session.js claim` prints `"action": "noop"` for a card that was Todo when picked, another worker took it; stop.

**Plain backlog** (can honestly wait weeks): a normal card is fine; end with a `BACKLOG-OK: <why it can wait>` line or the Stop hook reads the hand-off as unfinished work.
