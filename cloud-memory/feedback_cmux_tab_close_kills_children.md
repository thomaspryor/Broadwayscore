---
name: feedback_cmux_tab_close_kills_children
description: cmux tab close (bsc-prune closeWorkspace or by hand) kills the claude session, its tool shells and every nohup/disown/& child; only setsid-detached (node detached:true) work survives. Also: a 'prune-closed' ledger row is a PRE-WRITE, not proof prune closed anything.
metadata:
  type: feedback
---

**Fact (verified live 2026-09-13, BRO-3218, claude 2.1.270 / cmux 0.64.22):** `cmux close-workspace` on a tab running an interactive Claude session kills, within 2s: the claude process, its Bash tool shell, and every child of that shell that is not in its own session — bare `&`, `nohup … &`, `& disown`, `( nohup … & )`, node `spawn(...,{detached:false})` all DEAD. Only node `spawn(...,{detached:true})` (setsid — `scripts/lib/spawn-detached-dispatch.js`, bsc-prune's redispatch) survived. cmux itself only hangs up the pty; it is claude's own exit-on-SIGHUP that kills its tool-shell process group, so nohup does not help from inside a session.

**Incident it explains (BRO-3068, 2026-09-08):** the headless BRO-3076 job ran /wrap-up Phase 7, `cmux identify` returned `caller: null` (headless = no CMUX_* env), the model fell back to `focused.workspace_ref` and ✅-renamed the owner's focused tab — BRO-3068's live session. bsc-prune then SKIPPED that tab every tick (mid-turn), but `scripts/bsc-prune.js:196` pre-writes a `prune-closed` ledger row for every ✅ tab before deciding, so two later sessions wrongly concluded "auto-prune closed a live tab". Filed as BRO-3228. That session's claude (2.1.263) survived a hand close and kept working 4.5h — version-dependent, never rely on it.

**Why:** "THIS SESSION: CLOSE ME" while a background job started from this tab is still running = the job dies when the owner prunes the tab.

**How to apply:**
- Anything that must outlive the tab goes through `spawn-detached-dispatch.js` / `spawn(...,{detached:true, stdio:['ignore',fd,fd]}).unref()`, and is named on the CONTINUING line; CLOSE ME only when nothing this tab started is still alive (`pgrep -P $CMUX_CLAUDE_PID`).
- Never mark/rename a workspace you did not resolve from `cmux identify` `.caller.workspace_ref`; `caller: null` means you have no tab — skip Phase 7 (hook `cmux-destructive-guard.sh` now blocks the hijack).
- To check whether prune actually closed a tab, read `~/Library/Logs/bsc-autoprune.log` "Closed N" / "Skipped N" lines, not the `prune-closed` ledger row.
- Repro recipe: `cmux new-workspace --name "🧪 throwaway" --cwd $S --command "bash $S/launch.sh"` (launch.sh execs `claude --dangerously-skip-permissions --model haiku "<prompt that runs a pid-writing script>"`), snapshot `ps -o pid,ppid,pgid,tty` for each pid, `CMUX_CLOSE_OK=1 cmux close-workspace --workspace workspace:N` (owner-approved throwaway only), re-check `ps -p`.

Related: [[feedback_never_close_unmarked_cmux_workspaces]], [[feedback_background_watchers_worktree_cwd]], [[feedback_liveness_needs_lsof_not_mtime]].
