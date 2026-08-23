# .claude/CLOUD.md — read first if you're a cloud Claude Code session

Cloud Claude Code apps (claude.ai/code, iOS, Mac desktop) run in stateless sandboxes that DON'T mount the user's `~/.claude/` config dir. That dir has 15 hooks, 22 slash commands, and 360+ memory files that you, the cloud session, can't see.

This file + a small set of project-scoped substitutes (`.claude/hooks/`, `cloud-memory/`) bring you closer to local CLI behavior.

## Before your first tool call

1. **Verify secrets:** `node scripts/check-cloud-secrets.js`. Env vars are set ONLY in the web UI (there is no CLI/API/repo-file path — verified against the official docs): claude.ai/code → **cloud icon showing the current environment's name** → hover environment row → **gear icon** → **Environment variables** field (`KEY=value` per line, no quotes). Caveat per Anthropic docs: NOT a dedicated secrets store — values are visible to anyone with environment edit access. `NOTION_API_KEY` must be pasted (notion-brain.js + the notion-create hook gate). **Set `REVIEW_TEXTS_TOKEN` too, to be safe:** the bootstrap ALSO tries a tokenless GitHub-proxy clone, but whether the proxy authenticates a clone of a *different* private repo (not the session's own) is **UNVERIFIED in a real cloud session** as of 2026-07-05 — if it doesn't, you silently get a STUB. The token is the guaranteed path. (A fine-grained PAT with read access to `thomaspryor/broadway-scorecard-data`.)
2. **Data bootstrap is automatic.** The `cloud-bootstrap.sh` SessionStart hook runs `scripts/cloud-bootstrap-data.sh`, which clones the real private data via (a) `REVIEW_TEXTS_TOKEN`, (b) `gh`, or (c) a tokenless GitHub-proxy clone (cloud only, `CLAUDE_CODE_REMOTE=true`, unverified — see #1); if all fail it synthesizes a buildable STUB from `public/data/mobile-shows.json` (reviews/scores empty). Either way it then runs the stub generator as a **gap-fill** to create the gitignored, locally-generated files the private repo doesn't ship (`cast-manifest.json`, `actor-slugs.json`, `video-reviews.json`, …) — without these the app fails `tsc` with TS2307 even with real data. In real-data mode those gap-filled files are EMPTY, so cast/actor/video features are degraded but the app builds. It also `npm install`s `@notionhq/client` on demand. If you still see no `data/shows.json`, run `bash scripts/cloud-bootstrap-data.sh` manually and read the output.
3. **Read accumulated learnings:** `cat cloud-memory/MEMORY.md` — the full index. Specific feedback files referenced in it live alongside it in `cloud-memory/`.

## Project hooks that fire in cloud (project-scoped subset)

- `.claude/hooks/session-start.sh` — critical-rules banner + integrity check
- `.claude/hooks/verify-edits.sh` — Stop hook; blocks "done" without Bash verification, and (since 2026-08-23) requires a closing SAFE TO EXIT / NOT SAFE TO EXIT line + blocks an unmerged PR with no stated blocker once a session did real work. Bypass: `NO-VERIFY: <reason>` in final message.
- `.claude/hooks/notion-create-block.sh` — PreToolUse Bash gate; blocks subsequent tool calls if a `notion-brain.js create` failed earlier in the session.
- `.claude/hooks/cloud-bootstrap.sh` — SessionStart; runs the data bootstrap above. Cloud-only by design (no user-level master); inert on local CLI where `data/shows.json` already resolves.
- `.claude/hooks/worktree-enforce.sh` — PreToolUse on `Edit|Write|NotebookEdit|Bash`; hard-blocks (exit 2) tracked-code edits (`src/`, `scripts/`, `.github/workflows/`, etc. — CLAUDE.md §1) made outside a worktree. Ported 2026-08-23 (task: cloud sessions had zero technical backstop for the worktree rule until then, PR #691) — was previously in the "does not fire in cloud" list below; if you're reading a stale copy of this doc elsewhere, this line is the correction.
- `.claude/hooks/pre-push-visual-gate.sh`, `.claude/hooks/pre-push-review-gate.sh`, `.claude/hooks/pre-merge-review-gate.sh`, `.claude/hooks/check-skill-redaction.sh` — PreToolUse `Bash` gates for visual-QA, ship-check, and skill-redaction enforcement before `git push`/`git merge`. **Known gap:** matcher is `Bash` only — a push done via the GitHub MCP connector (`mcp__github__push_files`/`create_or_update_file`) instead of `git push` bypasses all four (tracked in Notion).
- `.claude/hooks/enterworktree-guard.sh` — PreToolUse `EnterWorktree` gate; guards worktree NAME COLLISIONS only (`worktree-enforce.sh` above is the one that covers the actual §1 rule).
- `.claude/hooks/whitespace-nowrap-lint.sh` — PostToolUse `Edit|Write` warning for a recurring CSS overflow trap.

These are derivatives of `~/.claude/hooks/` masters. Each script self-skips if `$HOME/.claude/hooks/<basename>` exists (so on local CLI the user-level master fires; on cloud the project copy fires). 11 other user-level hooks still DO NOT fire in cloud (design-system-lint, etc.) — be extra careful with edits those local-only hooks would catch.

## Slash commands available in cloud

Cloud sees commands committed to `.claude/commands/` in this repo. Local CLI sees both project + user-level. Check `ls .claude/commands/` for what's available cloud-side. The planning suite (`/plan-review`, `/right-problem`, `/plan-tasks`) is committed here so cloud sessions get the tuned multi-model review instead of approximating it — Codex/Gemini legs self-degrade to Claude agents when those CLIs/keys are absent.

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

Tell the user: "I'm running in a cloud session, so I don't have access to X. Want me to (a) make do with what's here, or (b) wait for you to switch to a local session?"
