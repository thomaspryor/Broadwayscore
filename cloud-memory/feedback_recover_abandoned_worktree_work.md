---
name: feedback_recover_abandoned_worktree_work
description: "Before starting a large migration/refactor task, check .claude/worktrees/ for an abandoned worktree with uncommitted work on the same topic — it may be salvageable even if stale/un-pushed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fc89410-affb-4239-8b22-07f98c6708c6
  modified: 2026-08-12T04:55:40.751Z
---

An abandoned worktree with uncommitted changes can hold substantial, high-quality unfinished work — not just noise to ignore or clean up. On task #66 (Route 39 ScrapingBee scripts through fetchPage()), `git worktree list` surfaced a worktree named `kill-sb-premium-proxy`, last touched 10 days earlier, holding a ~1000-line diff across 14 files plus a new regression-guard test — clearly a prior session's real progress on the same task that died before committing.

**Why:** The stale worktree's own `main` had diverged so far from current `origin/main` (no common ancestor found via `git merge-base`) that committing directly from it would have silently reverted ~10 days of other sessions' merged work. The diff itself was still valid and high-quality.

**How to apply:** When starting a task that touches an area with prior related worktrees (`git worktree list`, look for topic-matching names), don't just check if it's a *live* session ([[feedback_enterworktree_name_collision_live_session.md]]) — also check `git status`/`git diff` for uncommitted work worth recovering. If found: extract the diff with `git diff` (not the worktree's own branch history), create a **fresh** worktree from current origin/main, and `git apply` the extracted diff there (falls back to manual reconciliation per-file where context has drifted) — never try to commit/merge from the stale worktree's own branch.
