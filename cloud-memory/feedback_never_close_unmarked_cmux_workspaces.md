---
name: never-close-unmarked-cmux-workspaces
description: "2026-07-14 incident — Claude bulk-closed 11 idle cmux workspaces the user was still using; only ✅-marked workspaces are ever closable, and cmux/bsc CLIs execute on --help"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 53acbb0e-e0c9-444c-9fdd-991f191cdf00
  modified: 2026-08-02T23:15:40.389Z
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
BOTH were removed at the time.

2026-08-02 OWNER REVERSAL (escalation: "I'm a babysitter... hideous"): automatic
closing IS back, deliberately, with the safety conditions the July incidents
lacked. Architecture:
- Trigger: workspace-mark-done.sh (Stop hook) runs `node scripts/bsc-prune.js`
  SYNCHRONOUSLY, throttled to 1/4min machine-wide via
  ~/.claude/state/bsc-autoprune-last-run. Synchronous is load-bearing: an
  orphaned (nohup/launchd-parented) process is REJECTED by cmux's socket
  ancestry ACL ("only processes started inside cmux can connect") — verified
  live 2026-08-02.
- What closes (FINAL, owner chose Option A 2026-08-02 evening, settling a
  same-day conflict where two sessions got opposite instructions): ONLY
  ✅+🤖 auto-dispatched tabs — dead or idle-at-prompt. NEVER: any tab the
  owner opened/typed in (even ✅ and fully dead — pruneDone reports it
  skipped, the owner closes it by hand), unmarked tabs, mid-turn tabs, or
  the SELECTED tab (re-checked immediately before each close — TOCTOU
  guard). Commit b79173bbc71 (verified landed on origin/main 2026-08-02
  ~23:20 UTC; f0911c58953 is an orphaned rebase-duplicate of the same
  change, not on origin) is the authoritative predicate; an
  escalation-#2 commit briefly widened this and was deliberately superseded
  — do NOT re-widen without a fresh explicit owner instruction. bsc-prune
  has a single-writer run lock; pruneClosedEntry dedupes terminal ledger
  breadcrumbs per launch.
- Backstop: launchd job com.broadwayscore.bsc-autoprune (every 5 min) is armed
  but DEAD until the next cmux app restart — ~/.config/cmux/cmux.json now sets
  automation.socketControlMode="password" (+CMUX_SOCKET_PASSWORD in the plist),
  which the running cmux instance has NOT picked up (ACL doesn't hot-reload;
  `cmux capabilities` still says cmuxOnly). After the next cmux restart, verify
  the launchd log (~/Library/Logs/bsc-autoprune.log) shows real sweeps AND that
  in-cmux cmux-CLI calls still work; revert config from
  ~/.config/cmux/cmux.json.bak-* if anything breaks.
Do NOT remove the Stop-hook trigger or "re-simplify" bsc-prune's guards — each
one maps to a real incident (2026-07-14/15/21).

2026-08-02 owner carve-out (duplicate tabs): when TWO live 🤖 auto-dispatched
workspaces are confirmed running the SAME task (same task id, verified via
dispatch-ledger + live process check), closing the redundant copy is LOW-STAKES —
owner said "why did I need to make a call?" after being asked. Recommend-and-act:
state which copy is being closed and why (keep the one further along / the one
the owner opened), prefix `CMUX_CLOSE_OK=1`, and report it. Do NOT extend this
to unmarked non-duplicate tabs — those still always go to the owner.

Related: [[feedback_absorb_gate_ceremony]]
