---
name: cmux-closed-tab-restore-recipe
description: How to restore closed cmux workspaces with their Claude sessions intact (2026-07-21 mass-close incident recipe)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f80a3aa3-df0c-4787-a582-819e28e9deb5
  modified: 2026-07-26T02:11:55.862Z
---

Closing a cmux workspace kills its claude process but NOT the conversation — transcripts persist and resume cleanly. Full restore recipe (used 2026-07-21 to recover 10 tabs closed by a rogue bsc-prune sweep):

1. **Identify victims**: `cmux list-workspaces` vs what the user expects. Transcript project dirs are keyed by cwd: main-repo sessions live in `~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl`, worktree sessions in `…-Broadwayscore--claude-worktrees-<name>/`. Victims of a mass-close all share the same last-mtime (the kill moment). Locked entries in `git worktree list` mark worktrees that had live sessions.
2. **Confirm no orphan process** (else resume conflicts): `ps aux | grep claude` + `lsof -p <pid> -d cwd`.
3. **Restore each**: `cmux new-workspace --name "<orig title> (restored)" --cwd <orig cwd> --command " bash <script>" --focus false` where the script runs `claude --resume <session-uuid>`. Use the script-file indirection (bsc-next.js pattern) — typing the command raw races shell init. cwd MUST match the transcript's project dir or resume won't find the session.
4. **Verify**: `cmux top --workspace workspace:N --processes --format tsv` has a `process` row parented to `…:tag:claude_code`.

**Forced cmux RESTART (2026-07-25) is a different case from closed tabs — workspaces survive, sessions die:**
1. Victims = all jsonl with the same mtime cluster (kill moment, e.g. 21:55:26-28); sessions whose transcripts predate the cluster were already dead pre-crash and need no restore. Read each victim's last assistant message first — skip ones that ended `SAFE TO EXIT`.
2. **cmux itself lazily auto-restores a pane's claude (`claude --resume <uuid>`, plain argv) when its tab is first selected/loaded after restart.** A manual resume in a new surface therefore creates a TWIN on the same session id the moment the tab loads — kill the idle twin (identify: cmux-restored = plain argv; typed-in-terminal = wrapped with cmux `--settings` hooks blob). Two processes on one transcript risk interleaved jsonl writes.
3. Unloaded (background) tabs have NO live terminal surface — `read-screen`/typed input fail with "Terminal surface not found". `cmux send` + `send-key enter` to a surface QUEUE and execute when the tab is selected; so: `new-surface --focus false` → send resume cmd + enter → `select-workspace` (loads + fires it) → verify pid → `move-surface --index 0 --focus true` to front the live surface → `close-surface` the dead original.
4. Resume with the session's original model (read last assistant `message.model` from the jsonl); resume itself costs no tokens — only nudged sessions spend. Nudge mid-work sessions with a one-line "cmux crashed, restored, continue"; do NOT nudge sessions awaiting a user decision.

**Why:** tabs die silently (prune bugs, crashes); the user's instinct is that the work is lost — it isn't.
**How to apply:** never re-drive lost sessions from scratch; always resume by uuid. Who ran a destructive sweep: grep `~/.claude/projects/**/*.jsonl` for the command, check tool_use timestamps. Related: [[feedback_never_close_unmarked_cmux_workspaces]].
