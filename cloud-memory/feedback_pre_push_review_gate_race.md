---
name: feedback_pre_push_review_gate_race
description: pre-push-review-gate.sh drift budget races against fast concurrent main pushes; unpushed local merge commits in the main repo dir can vanish between EnterWorktree merge and push
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3c151755-27a8-4c9e-b741-7bbf9a607b1b
  modified: 2026-07-31T00:26:23.146Z
---

`git checkout main && git merge <worktree-branch>` in the main repo dir followed by a
blocked `git push` (pre-push-review-gate.sh: stale verdict, drift budget exceeded) is not
safe to leave sitting — something in this environment periodically re-syncs the main repo's
`main` checkout with origin, and an unpushed local merge commit there can be gone (branch
reset to origin) by the time you retry. Confirm with `git merge-base --is-ancestor <mycommit>
HEAD` before assuming a blocked push just needs a retry; if it fails, the commit only survives
on the worktree branch — redo the merge from there.

Separately, `node scripts/lib/review-gate.mjs --query=record` snapshots the diff at the moment
it runs. In a repo with multiple concurrent auto-dispatched sessions pushing to main, origin can
move again in the seconds between `record` and `git push`, making the just-recorded verdict
stale again (same symptom, new gatedLines count with different files listed — check the file
list changed, not just the count, to tell this apart from a retry of the same failure).

**Why:** 2026-07-21, card #249 (extract weekly-monitor-runner) — push blocked twice: once by
drift from an already-landed parallel session (#250 flag-parity guardrail, 717 lines), then
again seconds after recording a fresh verdict because yet another push (check-cron-health.yml,
ambiguous-const fixtures) landed on origin first. First blocker required a scoped Codex
adversarial review of the accumulated diff (not just my own small diff) before `record` would
be honest; second blocker was pure timing and resolved by pulling, merging, recording, and
pushing in tight immediate succession with no gap for another push to land in between.

**How to apply:** In this repo (fast concurrent auto-dispatch), treat "pull → merge → record →
push" as one atomic sequence to run back-to-back, not as separate steps to think between. If
push fails with "stale verdict... N gated lines changed since," re-run the whole sequence rather
than just re-recording — the diff base has moved. If a push is blocked and you step away (e.g.
to run an adversarial review), re-verify your commit is still an ancestor of local `main` HEAD
before trusting a bare retry.

**Related trap (2026-07-24, task #421 systemic run-budget audit):** `EnterWorktree` with a bare
`name:` (no `path:`) always branches from `origin/<default-branch>`, never from local `main` —
it does not know or care that local `main` has commits origin doesn't yet have. If a push was
just blocked by this gate and you call `EnterWorktree` again before resolving the block, the new
worktree silently lacks your unpushed merge — `grep` for your just-added code in the fresh
worktree comes back empty, looking like the edit never landed. Fix: resolve the blocked push
(ship-check → record → push) BEFORE spinning up another worktree for follow-up work; if you
already created a stale one, `git log --oneline -3` in it first — if it doesn't show your commit,
abandon it (`ExitWorktree action:"remove" discard_changes:true`, nothing lost, it was empty) and
re-`EnterWorktree` after the push succeeds.

**Related trap (2026-07-30, card #670 digest-content-invariants):** `record` diffs COMMITTED
state vs `origin/main`, not the working tree. Running `--query=record` right after finishing
edits — before `git add`/`git commit` — silently records a false-positive pass: `diffHash:
"empty"`, `gatedLines: 0`. The push-boundary hook would then trust a verdict that covers zero of
the actual diff. Always commit first, then record — the tool gives no warning that it snapshotted
nothing.
