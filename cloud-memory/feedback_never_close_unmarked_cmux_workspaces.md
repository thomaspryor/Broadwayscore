---
name: never-close-unmarked-cmux-workspaces
description: "2026-07-14 incident — Claude bulk-closed 11 idle cmux workspaces the user was still using; only ✅-marked workspaces are ever closable, and cmux/bsc CLIs execute on --help"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 53acbb0e-e0c9-444c-9fdd-991f191cdf00
  modified: 2026-09-07T23:09:16.375Z
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

2026-09-07 socket-password-mode broke everything, reverted: cmux.app restarted
~17:16 that day and picked up automation.socketControlMode="password" for the
first time (set 2026-08-02, never live until this restart). Result: the CLI
socket file (~/Library/Application Support/cmux/cmux.sock) stopped being
created at all — every `cmux` CLI call, including from inside a live cmux tab,
failed "Socket not found" (not an auth error). This killed bsc-autoprune
(launchd, failing every 5min), bsc-prune, dispatch-watchdog, and
zombie-tab-sweep simultaneously — the entire auto-close/dispatch layer was
dark with no alert. Reverted cmux.json automation block back to
{"socketControlMode":"cmuxOnly"} (matches pre-2026-08-02 behavior); takes
effect on next cmux restart (owner's call — bounces all live tabs). If
password mode is wanted again, it needs the CLI wrapper (cmux-workspaces.js
run()) to actually pass the password, not just the app-side config flag.
Separately, confirmed by design (not a bug): 👑-prefixed "Crown" successor-
chain tabs (v24...v46+, one per hand-off) are permanently exempt from all
auto-close paths (isCrownTab() in prune-closeable.js, task #1751) — they will
keep accumulating forever and need a periodic owner-approved manual sweep.

2026-09-07 root cause found + FIXED (BRO-2946, commits eb337a1a4 + 711500aa3): the
"periodic owner-approved manual sweep" this file kept saying Crown tabs needed had
never actually happened — a BRO-343 succession chain accumulated 55 concurrent LIVE
duplicate Crown tabs over ~6 weeks (v20-v46), all running on the bare checkout at
once (323% CPU, 22.8GB RAM). Two shipped fixes: (1) scripts/lib/crown-duplicate-
detector.js — report-only, groups live Crown tabs by dispatch-ledger taskId, wired
into bsc-prune's existing Stop-hook sweep so a future pileup is loud instead of
silent; (2) scripts/bsc-next.js selfCloseAfterSuccession() — the actual root-cause
fix: a succession predecessor now closes ONLY its own tab (via $CMUX_WORKSPACE_ID,
confirmed set in every cmux-launched session) right after its successor is
confirmed launched. This is a NEW, narrower safe pattern, distinct from the
external "one session closes ANOTHER tab" pattern every incident above is about —
self-close by known-own-id, fail-safe on any lookup miss, TOCTOU re-checked right
before the close call, kill switch SUCCESSION_SELF_CLOSE_DISABLED=1.
Residual, tracked, not yet fixed: BRO-2949 — findLiveWorkspaceForTask (shared by
bsc-next.js and linear-next.js to block a FRESH re-dispatch onto an already-live
task) matches via a 20-char TITLE PREFIX, but Crown succession titles reword
noticeably each hand-off — very likely why fresh re-dispatches of BRO-343 kept
slipping past this guard and starting new parallel chains despite it existing.
Fix belongs in the shared dispatch-guards.js primitive (taskId-first, like
crown-duplicate-detector.js and zombie-tab-sweep.js already do), needs its own
rule-18 review given how many callers depend on its exact behavior.

Related: [[feedback_absorb_gate_ceremony]]
