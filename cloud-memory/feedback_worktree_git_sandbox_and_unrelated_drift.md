---
name: worktree-git-sandbox-and-unrelated-drift
description: "Worktree sessions can't git-log a sibling private-data repo (data/review-texts); also don't proactively \"clean up\" unrelated dirty-tree/behind-origin warnings before starting your actual task."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 95bfb7d8-bbd9-4cbe-afa5-d2b03e4c323b
  modified: 2026-09-13T18:21:53.487Z
---

Two related session-discipline lessons from a BRO-3219 audit session (2026-09-13).

**1. A worktree-isolated session cannot run `git` pointed at any directory outside its own worktree** — not `git -C ~/broadway-review-texts`, not `cd path && git ...`, even for pure read-only history queries on a legitimate sibling repo (e.g. `data/review-texts`, a separate git checkout, not nested in the Broadwayscore tree). The sandbox blocks the command outright with a "must target its own worktree" error, regardless of intent.

**How to apply:** If an audit/analysis script needs cross-repo git history (e.g. "who last touched this field and when"), don't rely on `git log`/`git blame` on a sibling repo from inside a worktree. Either (a) do that specific analysis from the main checkout *before* calling `EnterWorktree`, or (b) redesign the predicate to use in-file breadcrumbs/timestamps already present in the JSON (`rejectedAt`, `urlDiscoveredAt`, `_urlChangedClear.at`, etc.) instead of git history — this is usually possible and is actually more portable (works even if history gets squashed). The shippable script itself can still shell out to git fine when it's *run* from the main checkout later; the restriction is only on *this interactive session* while worktree-isolated.

**2. Don't proactively "clean up" unrelated dirty-tree / behind-origin warnings before starting your actual task.** The session-start hook's "17 commits behind + uncommitted changes in data/review-texts" warning is informational, not a blocker to resolve before beginning work. Attempting to fully reconcile it (commit pending pipeline files, pull --rebase, resolve conflicts) dragged this session into a live automated self-heal loop on an unrelated file (`jane-eyre.../theatreandtonic--penny-walshe.json` flapping `wrongShow`/`wrongShowAutoCleared` — see [[feedback_stale_flag_collision_drops_current_production.md]]) that a different concurrent process was actively rewriting, costing several merge-conflict-resolution round trips before the actual task even started.

**How to apply:** Only sync/commit what your OWN task's correctness requires (e.g. confirm the specific data you're about to read is not stale). If a background warning names files you have no reason to touch, leave them — a concurrent automated process almost certainly owns them and will reconcile on its own next cycle. Second-order cost realized this session: the merge-conflict resolution I picked (keeping a stale field alongside a live one) silently reintroduced a self-contradictory data state that broke CI's Data Validation job days later in this same session, requiring a second investigation and fix (`node scripts/audit-self-contradictory-clears.js --fix-safe`) to undo.
