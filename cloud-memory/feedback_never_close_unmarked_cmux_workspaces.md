---
name: never-close-unmarked-cmux-workspaces
description: "2026-07-14 incident — Claude bulk-closed 11 idle cmux workspaces the user was still using; only ✅-marked workspaces are ever closable, and cmux/bsc CLIs execute on --help"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 53acbb0e-e0c9-444c-9fdd-991f191cdf00
---

On 2026-07-14 I closed 11 "idle" cmux workspaces (no running claude process, associated
tasks done). The user was still using several of them (mid-Mezzanine-import instructions,
a pending scoring decision, long-lived reference tabs). Then `cmux restore-session --help`
IGNORED the --help flag and executed a real restore, replacing the whole window state and
killing the remaining live sessions. Recovery required resuming 14 sessions by jsonl
session-id from ~/.claude/projects.

**Why:** "No claude process + task completed" does NOT mean the user is done with a tab.
Idle workspaces hold pending user actions, decisions, and scrollback the user returns to.
bsc-prune's design encodes this: it closes ONLY ✅-marked workspaces and explicitly lists
idle-unmarked ones as "review yourself" — meaning surface to the USER, not close myself.

**How to apply:**
1. NEVER `cmux close-workspace` a workspace that isn't ✅-marked. To clean up, run
   `node scripts/bsc-prune.js` (closes ✅ only) and report the idle-unmarked list to the
   user with titles; they decide.
2. NEVER pass `--help` to bsc-* scripts or cmux subcommands speculatively — several
   (bsc-conductor.js, `cmux restore-session`) execute their real action on --help.
   Read the script source or run with `--dry-run` instead.
3. Recovery recipe if sessions are ever killed: session jsonl files live in
   ~/.claude/projects/<mangled-cwd>/<session-id>.jsonl; find recent ones by mtime,
   identify via first user message, relaunch with
   `cmux new-workspace --name <title> --cwd <original-cwd> --command "claude --resume <id> --dangerously-skip-permissions"`.
   Resume cwd must match the project dir the jsonl lives under.

Guard-hook side effect: the PreToolUse guard (cmux-destructive-guard.sh) matches
the destructive subcommands as bare tokens in ANY Bash command — so a grep/echo
whose *pattern text* contains "close-workspace" is blocked too. For meta-commands
about the guard itself, split the token in the pattern (e.g. `close.workspace`);
CMUX_CLOSE_OK=1 remains reserved for user-approved real closes.

2026-07-15 follow-up (3 incidents that day): wrap-up Phase 7's self-close killed
a tab mid-typing, and bsc-next's dispatch-time pruneDone() sweep closed another.
BOTH are removed — sessions only ✅-mark; the ONLY closer is owner-run bsc-prune
(bsc-conductor runs it --dry-run only). Never reintroduce automatic closing.

Related: [[feedback_absorb_gate_ceremony]]
