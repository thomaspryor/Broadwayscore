---
name: feedback_pkill_kills_other_sessions_dev_servers
description: "pkill -f \"next dev\" matches every dev server on the machine, not just yours — kills other parallel sessions' dev servers in this multi-worktree repo"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c76dd14b-6af7-47df-bbcc-dc234ad88c3a
  modified: 2026-07-21T03:48:32.918Z
---

`pkill -f "next dev"` (or any broad process-name match) kills every matching process across the whole machine — this repo routinely has 15-20+ active worktrees (`git worktree list`), several with their own `npm run dev` running simultaneously. During card #258 (2026-07-20), two `pkill -f "next dev"` calls to clean up a local verification server killed another session's dev server on port 3000; it came back up under a new PID (probably that session's own watchdog/restart), so no work was lost, but it could have been mid-request or mid-debug for that session.

Also: `pkill -f "next dev.*3411"` silently matched nothing and did nothing, because `PORT=3411` is set as an env var, not passed as a CLI arg — `next dev`'s process command line never contains the port number, so a pattern trying to scope by port via `-f` is a no-op that looks like it worked (no error, exit 0) while leaving the process running.

**Why:** broad `pkill -f` has no concept of "mine" vs "another session's" — it matches on command-line text only, machine-wide.

**How to apply:** before killing a dev server you started, get its exact PID first (`lsof -iTCP:<port> -sTCP:LISTEN -P` right after starting it, or capture `$!` from the background launch) and `kill <PID>` that specific process. Never `pkill -f "next dev"` or similar broad patterns in this repo — always assume other sessions have matching processes running. If you must find a process by port, `lsof -iTCP:<port> -sTCP:LISTEN -P` is the reliable lookup; grepping for the port number in `ps`/`pkill -f` output does not work because Next.js doesn't echo `$PORT` into its argv.
