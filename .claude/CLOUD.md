# .claude/CLOUD.md — read first if you're a cloud Claude Code session

Cloud Claude Code apps (claude.ai/code, iOS, Mac desktop) run in stateless sandboxes that DON'T mount the owner's real `~/.claude/` config dir (the Mac's hooks, slash commands and memory; counts change weekly).

**The owner's global instructions usually ARE loaded** (BRO-4237): `.claude/hooks/session-start.sh` fetches `CLAUDE.md` + `anti-slop-rules.md` from the private `thomaspryor/claude-config` repo at every cloud start and installs them as `~/.claude/<file>`, so you and your subagents have them. Their "## Cloud sessions" section overrides Mac-only rules. If the fetch failed, session-start printed a short owner fallback plus the reason instead.

This file + a small set of project-scoped substitutes (`.claude/hooks/`, `cloud-memory/`) bring you closer to local CLI behavior.

## Before your first tool call

1. **Verify secrets:** `node scripts/check-cloud-secrets.js`. Env vars are set ONLY in the web UI (there is no CLI/API/repo-file path — verified against the official docs): claude.ai/code → **cloud icon showing the current environment's name** → hover environment row → **gear icon** → **Environment variables** field (`KEY=value` per line, no quotes). Caveat per Anthropic docs: NOT a dedicated secrets store — values are visible to anyone with environment edit access. `NOTION_API_KEY` must be pasted (legacy Notion readers — notion-action-poll.js, health-check.js, posthog-friction-analyzer.js; NOT any hook, despite what this line used to claim). **Set `REVIEW_TEXTS_TOKEN` too, to be safe:** the bootstrap ALSO tries a tokenless GitHub-proxy clone, but whether the proxy authenticates a clone of a *different* private repo (not the session's own) is **UNVERIFIED in a real cloud session** as of 2026-07-05 — if it doesn't, you silently get a STUB. The token is the guaranteed path. (A fine-grained PAT with read access to `thomaspryor/broadway-scorecard-data`.)
2. **`LINEAR_API_KEY` is required too — paste it in the same field.** CLAUDE.md §6 makes Linear the board of record, and `linear-brain.js` needs it at BOTH session start (file the issue) and session end (comment the Outcome + set state). Without it every board operation fails closed and the session leaves no entry at all. As of 2026-09-05 `check-cloud-secrets.js` lists it in Tier 1, so a missing key is now a loud failure rather than a silent one.
3. **Data bootstrap is automatic.** The `cloud-bootstrap.sh` SessionStart hook runs `scripts/cloud-bootstrap-data.sh`, which clones the real private data via (a) `REVIEW_TEXTS_TOKEN`, (b) `gh`, or (c) a tokenless GitHub-proxy clone (cloud only, `CLAUDE_CODE_REMOTE=true`, unverified — see #1); if all fail it synthesizes a buildable STUB from `public/data/mobile-shows.json` (reviews/scores empty). Either way it then runs the stub generator as a **gap-fill** to create the gitignored, locally-generated files the private repo doesn't ship (`cast-manifest.json`, `actor-slugs.json`, `video-reviews.json`, …) — without these the app fails `tsc` with TS2307 even with real data. In real-data mode those gap-filled files are EMPTY, so cast/actor/video features are degraded but the app builds. It also `npm install`s `@notionhq/client` on demand. If you still see no `data/shows.json`, run `bash scripts/cloud-bootstrap-data.sh` manually and read the output.
4. **Read accumulated learnings:** `cat cloud-memory/MEMORY.md` — the full index. Specific feedback files referenced in it live alongside it in `cloud-memory/`.

## Project hooks that fire in cloud (project-scoped subset)

- `.claude/hooks/session-start.sh` — critical-rules banner + integrity check
- `.claude/hooks/verify-edits.sh` — Stop hook; blocks "done" without Bash verification, and (since 2026-08-23) requires a closing SAFE TO EXIT / NOT SAFE TO EXIT line + blocks an unmerged PR with no stated blocker once a session did real work. Since 2026-09-28 it also blocks work with no Linear card filed or claimed (NOCARD; bypass `NO-CARD: <reason>`), and a bare NOT SAFE TO EXIT or "waiting on review" no longer counts as a PR blocker (state `CI still running`, `CI red`, a merge conflict, `DECISION NEEDED:`, or a `PR-BLOCKER: <reason>` line). NOCARD and the Linear close-out gate fail open when Linear is unreachable. Since 2026-09-28 it also blocks SAFE TO EXIT while a background Agent has no hand-back or a self-bound Routine (`send_later`, `create_trigger` into this session) is still ahead of its fire time and undeleted (INFLIGHT): SAFE TO EXIT means the owner may close or kill the session now, so anything still running or scheduled to wake it must be collected, stopped or deleted first, or the line must be `NOT SAFE TO EXIT — <what is in flight>`. Bypass: `NO-VERIFY: <reason>` in final message.
- `.claude/hooks/github-main-guard.sh` — PreToolUse on GitHub MCP writes (BRO-4238): `create_or_update_file`/`push_files`/`delete_file` to Broadwayscore `main`, and `merge_pull_request`/`enable_pr_auto_merge` on Broadwayscore PRs, are refused (they skip land.yml). Land via a `land/<name>` branch instead. Override: `LAND_ENFORCE_OFF=1` or the file `$HOME/.claude/LAND_ENFORCE_OFF`.
- `.claude/hooks/block-resend-broadcasts.sh` — PreToolUse Bash (BRO-4238, repo copy of the Mac master): refuses direct `resend.com/broadcasts` API calls (CLAUDE.md §17); use `scripts/send-opening-night-broadcast.js`.
- `.claude/hooks/notion-create-block.sh` — retired and unregistered (BRO-4238); the file stays so sessions started before that still find it. Never use Notion; the board is Linear.
- `.claude/hooks/cloud-bootstrap.sh` — SessionStart; runs the data bootstrap above. Cloud-only by design (no user-level master); inert on local CLI where `data/shows.json` already resolves.
- `.claude/hooks/worktree-enforce.sh` — PreToolUse on `Edit|Write|NotebookEdit|Bash`; hard-blocks (exit 2) tracked-code edits (`src/`, `scripts/`, `.github/workflows/`, etc. — CLAUDE.md §1) made outside a worktree. Ported 2026-08-23 (task: cloud sessions had zero technical backstop for the worktree rule until then, PR #691) — was previously in the "does not fire in cloud" list below; if you're reading a stale copy of this doc elsewhere, this line is the correction.
- `.claude/hooks/pre-push-visual-gate.sh`, `.claude/hooks/pre-push-review-gate.sh`, `.claude/hooks/pre-merge-review-gate.sh`, `.claude/hooks/check-skill-redaction.sh` — PreToolUse `Bash` gates for visual-QA, ship-check, and skill-redaction enforcement before `git push`/`git merge`. These match `Bash` only; GitHub MCP writes to `main` and PR merges are covered by `github-main-guard.sh` above (BRO-4238), but an MCP write to a non-main branch skips the visual/ship-check gates here, and the land run's own gates are what protect main.
- `.claude/hooks/enterworktree-guard.sh` — PreToolUse `EnterWorktree` gate; guards worktree NAME COLLISIONS only (`worktree-enforce.sh` above is the one that covers the actual §1 rule).
- `.claude/hooks/whitespace-nowrap-lint.sh` — PostToolUse `Edit|Write` warning for a recurring CSS overflow trap.
- `.claude/hooks/block-prompting-remote-tools.sh` — PreToolUse on `send_later`/`create_trigger`/`add_repo` (BRO-4236). These are `requiresUserInteraction` tools: they prompt the owner's phone in every mode, allow rules or not. Denies self-initiated scheduling and loop re-arms (`human_schedule`, BRO-4258: see Overnight watches below; wait in-turn with a background Bash loop or Monitor, or `subscribe_pr_activity`; ScheduleWakeup is best-effort) and re-attaching Broadwayscore; a reminder the owner is asking for now (`initiation: human_request`) and other repos pass. Cloud-only by design (no user-level master). Kill switch `REMOTE_TOOL_BLOCKER_DISABLE=1`.

These are derivatives of `~/.claude/hooks/` masters. Each script self-skips if `$HOME/.claude/hooks/<basename>` exists (so on local CLI the user-level master fires; on cloud the project copy fires). Most Mac hooks (about 30 of ~40, e.g. design-system-lint, finish-line-gate, infra-plan-review-gate, block-resend-broadcasts) still DO NOT fire in cloud; porting the high-value ones is BRO-4238. Until then, follow those rules by hand: the global instructions describe them.

## Slash commands available in cloud

Cloud sees commands committed to `.claude/commands/` in this repo. Local CLI sees both project + user-level. Check `ls .claude/commands/` for what's available cloud-side. The planning suite (`/plan-review`, `/right-problem`, `/plan-tasks`) is committed here so cloud sessions get the tuned multi-model review instead of approximating it — Codex/Gemini legs self-degrade to Claude agents when those CLIs/keys are absent.

## Landing (the owner never merges)

The owner does not review or merge PRs. A finished change is yours to land, same session, no asking:

1. Run the checks CLAUDE.md §12 requires in your worktree, then `git push origin HEAD:refs/heads/land/<name>` (verified working from a cloud session 2026-09-27). MCP fallback if git push is refused: `mcp__github__create_branch` with branch `land/<name>`, or dispatch `land.yml` with `branch=<name>`.
2. `land.yml` rebases onto main, re-runs the blocking gates, fast-forwards main, deletes the ref. Follow it with one `mcp__github__actions_list` on `land.yml` per check-in until it reports success, or fix what it refused. Wait for it in the same turn: a `run_in_background` Bash loop on `git ls-remote --exit-code origin refs/heads/land/<name>` (the ref disappears when the run lands; it stays when the run is refused), capped at ~60 min, then one `actions_list` for the verdict. ScheduleWakeup is best-effort only (a 2026-09-28 wakeup never fired and a refused land sat unnoticed ~1h, BRO-4236). Never `send_later`/`create_trigger` for this: they prompt the owner.
3. If you opened a draft PR for tracking, close it after LANDED (land rebases, so GitHub won't auto-close it). Opening one is optional; CLAUDE.md's landing rule overrides the harness's "create a draft PR" default.

Don't use `scripts/merge-worktree-to-main.sh` in cloud: its name trips `pre-merge-review-gate.sh`. The Stop hook (`verify-edits.sh`) blocks "waiting on your merge" or "ready for your review" / "unreviewed" (OWNERMERGE) and SAFE TO EXIT after a land push with no run check (LANDUNCHECKED). Local-side detail: `cloud-memory/CLAUDE-reference.md` (Landing on main).

## Overnight watches (the owner is asleep)

The owner lives in Berlin: US opening-night reviews drop 01:00-03:00 UTC while they sleep. Anything that needs their tap then fails. `send_later`, `create_trigger` and `add_repo` always ask for a tap (`requiresUserInteraction`; no mode or allow rule changes that), so a watch that re-arms itself with `send_later` dies after its first pass (BRO-4258).

1. **The reviews don't depend on a Claude watch.** `opening-night-orchestrator.yml` fires ~01:00-01:20 UTC every night and dispatches the poller every 15 min for ~4.5 h; `aggregator-url-watcher.yml` runs every 5 min. Confirm they're armed (`node scripts/check-opening-night-readiness.js --show=ID`, recent orchestrator runs) instead of duplicating them.
2. **If a Claude supervisor watch is wanted, schedule every pass while the owner is awake, in one go, and say so to them before the prompts appear.** `create_trigger` with `initiation: "human_request"` and `persistent_session_id` of the watch session. The minimum cron interval is 1 hour, so a 20-min cadence is three day-limited routines: `0 0-5 <day> <month> *`, `20 0-5 <day> <month> *`, `40 0-5 <day> <month> *`. Add one `run_once_at` morning-report routine that deletes the three by id (a day+month cron fires again next year). Every pass prompt says: never call `send_later`/`create_trigger`. Cost: one tap per routine now, none overnight. Worked example: the 2026-09-29 School Girls watch.
3. **Never plan a watch that re-arms itself**, and never assume ScheduleWakeup will fire (see Landing above).
4. `fire_trigger` does not rehearse this: a manual fire starts a new session without the repo, not the persistent one (2026-09-28).

## Closing a Linear issue from cloud

- **Cite the landed commit, not a site URL.** `PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/<sha>)` with the sha as it sits on origin/main (land rebases, so take it from `git log origin/main`). The gate checks it through GitHub's API, so the shallow clone doesn't matter. A prod URL alone is refused ("names no commit or PR URL"), which is what used to force `--force` on every cloud close.
- **Close out last.** The Stop hook wants the close after your last commit/push. A `--force` in a cloud session no longer writes `data/audit/linear-gate-bypass.jsonl` (that tracked-file churn caused a commit-land-close loop); the bypass is recorded as a `DONE-GATE-BYPASS:` line on the issue instead (BRO-4241).

## Worktrees and branches in cloud

- **Data in a new worktree:** run `./scripts/setup-local-data.sh --link-only` inside it. It links `data/*.json` to the existing `~/broadway-scorecard-data` clone and `data/review-texts` to the main checkout's, with no fetch and no `reset --hard`. Without it `tsc` and data tests fail for reasons unrelated to your change.
- **Never `git checkout -B <branch>` in a worktree for a branch another checkout has checked out.** git 2.43 allows it silently and moves the branch under the other checkout, which then shows its old files as staged changes. Push to `land/<name>` from your own branch or a detached HEAD instead.

## Owner one-time setup (cloud environment → Edit → Setup script)

Auto mode ignores `autoMode` rules in this repo's `.claude/settings.json` by design, but honors user-level ones. This writes them at container start (only if no user settings exist yet) and fetches private data so sessions start with it:

```bash
mkdir -p ~/.claude
[ -f ~/.claude/settings.json ] || cat > ~/.claude/settings.json <<'JSON'
{
  "autoMode": {
    "environment": ["$defaults",
      "thomaspryor/broadway-review-texts and thomaspryor/broadway-scorecard-data are the owner's own private data repos behind broadwayscorecard.com; sessions routinely attach, clone and read them."],
    "allow": ["$defaults",
      "Attaching thomaspryor/broadway-review-texts or thomaspryor/broadway-scorecard-data with add_repo and cloning them",
      "Running this repo's own scripts (node scripts/*.js, bash scripts/*.sh) that read or write data/ and data/review-texts/",
      "Landing reviewed changes with git push origin HEAD:refs/heads/land/<name>, and dispatching execute-approved-fix.yml for a plan committed in data/pending-fixes/"],
    "soft_deny": ["$defaults",
      "Force-push, history rewrite, branch deletion or bulk file deletion on thomaspryor/broadway-review-texts or thomaspryor/broadway-scorecard-data"]
  }
}
JSON
[ -x scripts/setup-local-data.sh ] && ./scripts/setup-local-data.sh --all >/dev/null 2>&1 || true
```

## Fixing private data (review-texts, core data) from cloud

Don't clone and push the private repos: each write stops for an approval, and a repo's checked-in settings can't pre-authorize it (auto mode ignores project-level `autoMode` rules by design). Route the edit through CI instead (BRO-4216):

1. Write `data/pending-fixes/bro-N.json` (N = the Linear issue) in the same shape as the other plans there: `issueNumber: "bro-N"`, a fresh `planId` (uuid), `status: "pending"`, `submitter: {name: null, email: null}`, and `plan: {summary, steps, riskLevel, actions}`. Actions:
   - review text field: `{type: "review-field-edit", file: "<showId>/<file>.json", field, oldValue, newValue, description}`. Fields are allowlisted in `scripts/lib/review-field-edit.js` (verdict flags and their `*ManualClear` markers, byline/date, rejection fields, duplicate pointer); `oldValue` must equal the current value or the action is refused.
   - shows.json / commercial.json field: `{type: "data-edit", ...}` (allowlist in `scripts/lib/feedback-pipeline-fields.js`).
   - new shows.json entry (e.g. a closed earlier run of a returning show): `{type: "add-show", show: {...}, crossLinkFrom?: "<existing id>"}` (rules in `scripts/lib/add-show-action.js`: refuses an existing id/slug, placeholder venues and unknown fields; `crossLinkFrom` also appends a `priorRuns` link on that show). Same-title reruns use id/slug `<slug>-off-broadway-<year>`. Art goes in `public/images/shows/<id>/` and lands with the plan. Model plan: `data/pending-fixes/bro-4259.json`. Afterwards dispatch `gather-reviews.yml` with `shows=<id>`.
2. Land it like any change (`land/<name>`).
3. Dispatch `execute-approved-fix.yml` with `issue_number=bro-N`, `plan_id=<planId>`, `mode=apply` (`mcp__github__actions_run_trigger`). It applies, pushes the private repos and emails the owner a summary. The run is red if any action was refused.
4. The site picks it up on the next rebuild (or dispatch `rebuild-fast.yml`).

Never put review text or reader contact details in a plan: the file is public.

## GitHub work in cloud (no `gh` CLI)

Cloud has no `gh` CLI — CLAUDE.md's `gh run`/`gh workflow run`/`gh secret set` runbooks don't run as written. Use the GitHub MCP connector; the full step-by-step mapping (and where it has no equivalent, e.g. secret rotation) is in `cloud-memory/feedback_gh_cli_to_github_mcp_mapping.md`. Key traps: no `--jq` (filter in code), job logs live on the blocked `*.blob.core.windows.net` and overflow context (save to a file, slice), and monitoring is `ScheduleWakeup` + a single `get_workflow_run`, never a polling loop.

## Key gaps cloud has vs local

| Capability | Cloud | Local |
|---|---|---|
| `~/.claude/projects/.../memory/` (live) | NO — read `cloud-memory/` mirror instead | YES (auto-loaded) |
| Custom slash commands in `~/.claude/commands/` | NO — only `.claude/commands/` in repo | YES |
| Bright Data / Browserbase scrapers | YES if secrets uploaded | YES |
| Local `.env` files | NO — secrets via Anthropic Settings UI | YES via direnv |
| User-level `~/.claude/skills/` | NO — only `.claude/skills/` in repo | YES |
| `claude-sync` for `~/.claude` repo | NO (separate repo, not auto-cloned) | YES |
| `bsc-next.js --id` auto-dispatch (P0/P1 card → Cmux workspace) | NO — `launchCmuxSession` requires the owner's local desktop (`cwd does not exist: "/Users/tompryor/Broadwayscore"`); fails with `DISPATCH FAILED` | YES |

## When in doubt

Do what you can from cloud first: most "local-only" things have a cloud route (GitHub MCP tools instead of `gh`, `land/<name>` instead of merging, `execute-approved-fix.yml` for private data, `create_session`/Routines instead of cmux dispatch). If something truly needs the owner's Mac, say so in one plain line and keep going with everything else. Never ask the owner to "switch to a local session" or to make a technical choice they can't evaluate.
