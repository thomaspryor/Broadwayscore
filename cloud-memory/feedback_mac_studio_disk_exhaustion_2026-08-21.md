---
name: feedback_mac_studio_disk_exhaustion_2026-08-21
description: "Mac Studio disk hit near-zero free space (~200Mi of 460Gi) across ~90 concurrent worktrees; check df -h before npm run dev / builds, expect ENOSPC to block Bash entirely"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f6e52d62-5dbc-4183-8138-4002a4dbfe7e
  modified: 2026-08-21T09:44:16.586Z
---

The Mac Studio's root volume was found at 99% capacity with only ~200Mi free out of 460Gi during a BRO-573 session (2026-08-21), across ~90 concurrent `.claude/worktrees/*` checkouts. At that margin, even `node --check`-level Bash calls intermittently failed with ENOSPC (the harness's own per-session tool-output capture in `/private/tmp/claude-501/...` couldn't allocate), and a single `next dev` compile of one page was enough to exhaust the remaining bytes to 0, requiring a second (foreground, working) session to `lsof -tiTCP:<port> | xargs kill` and `rm -rf .next` before Bash worked again.

**Why:** disk pressure is systemic (many worktrees × node_modules/.next each), not caused by any one session, and there is no code fix — it needs a human to actually delete stale worktrees/caches, which no session should do unilaterally (risk of deleting another session's in-progress work).

**How to apply:**
- Before `npm run dev`, `npm run build`, or any large temp-file operation in a worktree, run `df -h /` first. Under ~1Gi free, do NOT start a dev server or build — the compile alone can zero out the remaining space and cause a machine-wide ENOSPC outage affecting every other concurrent session.
- If Bash itself starts failing with ENOSPC on trivial commands (`echo`, `true`), that is real disk exhaustion, not a fluke — retry a couple of times, but don't loop indefinitely; a subagent (fresh Bash invocation) can sometimes still get a command through when the main session's tool-output path can't.
- `node_modules` can be safely symlinked from the main checkout into a bare worktree (confirmed safe, ~0 disk cost, matches [[feedback_visual_qa_dev_server_in_worktree]]'s established pattern) — this is NOT the risk. The risk is `.next` build cache from an actual `next dev`/`next build` invocation.
- When visual QA genuinely cannot be run due to disk exhaustion, use the documented `SKIP-VISUAL-CHECK: <reason>` / `NO-VERIFY: <reason>` bypasses honestly (state it IS a rendering change, just deferred) rather than fabricating a passing visual check — this is what the bypass syntax exists for.
- If you free space by killing a dev server / `.next` cache, that alone is usually NOT enough (confirmed: killing this session's own 83M `.next` cache only recovered space to 121→203Mi, still critical) — the real consumer is spread across the ~90 worktrees and needs a broader, explicitly-authorized cleanup pass the owner should run (e.g. `du -sh .claude/worktrees/*/.next .claude/worktrees/*/node_modules` to find the worst offenders), not something any single session should do on its own initiative.
