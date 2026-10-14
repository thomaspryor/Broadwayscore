---
name: stale-origin-main-prefer-shallow-reclone
description: "In a cloud/sandboxed session, `git fetch origin main` from the long-lived main checkout can hang (60-120s+) or silently no-op leaving `origin/main` pinned to a stale commit; EnterWorktree can also return a stale checkout on its first call. Don't debug the fetch -- retry EnterWorktree once, or do a fresh `git clone --depth 1`."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 73d98ded-6cb2-588a-bcaf-ee591314c3be
---

Hit this 2026-09-29 (BRO-3138 ship-check follow-up session, resumed after a 19-day gap). Needed to push a one-line fix to `scripts/opening-night-poller.js`.

**Symptom chain:**
1. `git fetch origin main:refs/remotes/origin/main --force` from `/home/user/Broadwayscore` (the long-lived main checkout) either hung past a 120s timeout or completed but left `origin/main` pinned at a commit from *earlier in the same session*, 20+ real commits behind the actual GitHub tip (confirmed via the GitHub API directly — `main` there already had the expected content).
2. `EnterWorktree` (first call) produced a worktree branched from that same stale ref — not a fix, just inherited the staleness.
3. `EnterWorktree` (second call, different worktree name) branched from the CORRECT current tip. No code or environment change between the two calls — just a retry.
4. Separately, a fresh `git clone --depth 1 https://github.com/<owner>/<repo> /tmp/x` (bypassing the session's cached remote-tracking state entirely) also got the correct current tip, fast.

**Don't confuse this with the push-hang or shallow-poison signatures already documented** ([[feedback_git_trace_curl_diagnoses_push_hangs]], [[feedback_shallow_since_poisons_git_shallow]]) — those are push-direction or `.git/shallow`-corruption specific and diagnosed differently (`GIT_TRACE_CURL`, `.git/shallow` inspection). This is fetch-direction staleness/hang with no useful stderr at all.

**How to apply:** When `git fetch`/`git merge --ff-only origin/main` in the long-lived main checkout hangs past ~60s or "succeeds" but a value you just confirmed changed on GitHub isn't showing up locally, don't sink time into diagnosing the fetch itself:
1. Retry `EnterWorktree` once (a fresh worktree, different name) — often just resolves it.
2. If still stale/hanging, do a throwaway `git clone --depth 1 --branch <branch> https://github.com/<owner>/<repo> /tmp/<name>` — confirm content matches what you expect there, then either work from that clone (note: the project's worktree-enforcement hook still blocks direct edits to tracked code paths there, since it applies to any git working tree, not just the main checkout) or use it only to build the exact file content, and push via the GitHub API / a properly-fresh `EnterWorktree` worktree instead.
3. Cross-check any single "is main stale" question against the GitHub API directly (`get_file_contents` with `ref: main`) rather than trusting the local checkout — it's the fastest way to confirm whether the problem is real staleness or just your assumption.
