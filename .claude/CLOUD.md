# .claude/CLOUD.md — read first if you're a cloud Claude Code session

Cloud Claude Code apps (claude.ai/code, iOS, Mac desktop) run in stateless sandboxes that DON'T mount the user's `~/.claude/` config dir. That dir has 15 hooks, 22 slash commands, and 360+ memory files that you, the cloud session, can't see.

This file + a small set of project-scoped substitutes (`.claude/hooks/`, `cloud-memory/`) bring you closer to local CLI behavior.

## Before your first tool call

1. **Verify secrets:** `node scripts/check-cloud-secrets.js`. If Tier 1 is missing, ask the user to set them at claude.ai/code → click the **cloud icon showing the current environment's name** (top of the input area) → hover environment row → click the **gear icon** → paste into the **Environment variables** field (`KEY=value` per line, no quotes). Caveat per Anthropic docs: this is NOT a dedicated secrets store — values are visible to anyone with environment edit access.
2. **Read accumulated learnings:** `cat cloud-memory/INDEX.md` then `cat cloud-memory/MEMORY.md` for the full index. Specific feedback files referenced in the index live alongside it.

## Project hooks that fire in cloud (project-scoped subset)

- `.claude/hooks/session-start.sh` — critical-rules banner + integrity check
- `.claude/hooks/verify-edits.sh` — Stop hook; blocks "done" without Bash verification. Bypass: `NO-VERIFY: <reason>` in final message.
- `.claude/hooks/notion-create-block.sh` — PreToolUse Bash gate; blocks subsequent tool calls if a `notion-brain.js create` failed earlier in the session.

These are derivatives of `~/.claude/hooks/` masters. Each script self-skips if `$HOME/.claude/hooks/<basename>` exists (so on local CLI the user-level master fires; on cloud the project copy fires). 12 other user-level hooks DO NOT fire in cloud (worktree-enforce, design-system-lint, etc.) — be extra careful with edits the local hooks would catch.

## Slash commands available in cloud

Cloud sees commands committed to `.claude/commands/` in this repo. Local CLI sees both project + user-level. Check `ls .claude/commands/` for what's available cloud-side.

## Key gaps cloud has vs local

| Capability | Cloud | Local |
|---|---|---|
| `~/.claude/projects/.../memory/` (live) | NO — read `cloud-memory/` mirror instead | YES (auto-loaded) |
| Custom slash commands in `~/.claude/commands/` | NO — only `.claude/commands/` in repo | YES |
| Bright Data / Browserbase scrapers | YES if secrets uploaded | YES |
| Local `.env` files | NO — secrets via Anthropic Settings UI | YES via direnv |
| User-level `~/.claude/skills/` | NO — only `.claude/skills/` in repo | YES |
| `claude-sync` for `~/.claude` repo | NO (separate repo, not auto-cloned) | YES |

## When in doubt

Tell the user: "I'm running in a cloud session, so I don't have access to X. Want me to (a) make do with what's here, or (b) wait for you to switch to a local session?"
