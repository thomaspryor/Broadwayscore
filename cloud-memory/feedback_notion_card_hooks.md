---
name: Notion card enforcement hooks
description: "Commit + Stop creation + Stop closure gates. Bypass: NO-CARD."
type: feedback
originSessionId: c2e58658-4bcd-40b2-893d-e9f5df1bc602
archived: true
---
Notion card creation is enforced by hooks installed 2026-04-15 after a session ignored the SessionStart printed reminder and created a card retroactively at wrap-up. Soft reminders weren't enough.

**Why:** Global CLAUDE.md §6 and project §6 require every BWSC session to have an in-progress Notion card. The SessionStart hook printed the rule but no PreToolUse/Stop hook gated on it — a recurring policy violation across sessions. Reviewer (`/second-opinion`) recommended commit-boundary + stop-boundary enforcement instead of blocking the first Edit.

**How to apply:** Create the card before your first commit. Use the CLI: `node scripts/notion-brain.js create "Title" --status "In progress" --priority P1 --category Product --tags <tags> --notes "## Problem\n…\n\n## Acceptance criteria\n…"`. The PostToolUse `notion-create-verify.sh` captures the new card id into `/tmp/notion-card-${session_id}`. The commit and stop hooks check that sentinel.

**Mechanism**
- Sentinel: `/tmp/notion-card-${session_id}` — written on successful create. **Not cleared** when the card is closed (closing at /wrap-up is normal; clearing would lock the session out of post-wrap-up commits/stops). A new `create` overwrites with the most-recent card id. Sentinel records "this session created a card," not "card is currently open."
- `notion-card-required-commit.sh` — PreToolUse on `Bash(git commit*)`. **No bypass.** If sentinel missing AND Notion is reachable, exit 2. If Notion is unreachable (perl-alarm-wrapped probe times out), pass with stderr warning (per CLAUDE.md §6 fallback policy).
- `notion-card-required-stop.sh` — Stop hook. Two checks:
  - **Closure check (added 2026-04-15, demoted to silent-log 2026-04-25):** if the session created a card (sentinel exists), fetch its current status via `notion-brain.js get`. If still `"In progress"` or `"Not started"` → append one line to `~/.claude/logs/notion-card-open-at-stop.log` and exit 0 silently. **No stderr.** The user explicitly asked for the *session* to know the rules, not for them to see hook noise — so the closure rule lives here in memory and in CLAUDE.md §6, and Claude is expected to close cards proactively. The audit log lets us sweep stale cards or spot patterns later. Done/Paused → silent pass with no log entry.
  - **Creation check:** if no sentinel, scan transcript for Edit/Write/NotebookEdit on tracked-code paths (`src/`, `scripts/`, `.github/workflows/`, `CLAUDE.md`, top-level config). If any AND no `NO-CARD: <reason>` (≥5 chars) in latest assistant text → exit 2.
  - Probe budget: 4s via perl alarm. API down/unreachable → pass (can't block on a check we can't perform).
  - Corrupted sentinel (short/non-uuid) → pass (fall through, don't block on bad state).
- `notion-create-verify.sh` (PostToolUse on Bash) — captures card id from stdout JSON; clears sentinel on Done/Paused updates; preserves the existing failure-breadcrumb behavior for `notion-create-block.sh`.

**Bypass (Stop hook only):** include `NO-CARD: <reason>` in your final assistant text. Use sparingly — recorded in transcript, auditable. Meant for "this session's work doesn't warrant a card" cases (typo fixes, reverted exploration). The commit hook has NO bypass — if you need to commit, create a card.

**Failure modes**
- Notion unreachable: commit hook falls open with stderr warning. Stop hook only blocks if a sentinel SHOULD exist (i.e., session edited tracked code) — Notion reachability isn't probed at stop time, so a long-offline session that edited code still needs `NO-CARD:` to exit.
- Card created via Notion web UI: sentinel won't be written. Workaround: `echo <card-id> > /tmp/notion-card-${session_id}` manually, OR move the manually-created card to Done and recreate via CLI.
- Multiple parallel sessions: each gets its own session_id, so sentinels never collide.
- `/clear` and `/compact`: same session_id, sentinel survives. Good.
- New session in same shell: different session_id. Sentinel from prior session is orphaned (not auto-cleaned). Harmless — the new session has no sentinel under its id, so the gate fires correctly.

**Where:**
- `~/.claude/hooks/notion-create-verify.sh` (extended)
- `~/.claude/hooks/notion-card-required-commit.sh` (new)
- `~/.claude/hooks/notion-card-required-stop.sh` (new)
- `~/.claude/hooks/notion-create-block.sh` (existing — failure-retry block, now wired in settings.json after being orphaned)
- Registrations in `~/.claude/settings.json`
