---
name: feedback_working_tree_reads_mid_merge_stale
description: When investigating on a shared main checkout, parallel merges can mutate the tree mid-session; pin reads to `git show origin/main` and verify precedents exist at origin/main, not i
type: feedback
originSessionId: a2cfdb56-fbd1-4ff2-8d60-0cbf9fbe360b
draftedAt: 2026-07-26
---

# When investigating on a shared main checkout, parallel merges can mutate the tree mid-session; pin reads to `git show origin/main` and verify precedents exist at origin/main, not in in-flight worktree

**Why:** During this session, the main working tree was actively mutated by parallel sessions merging PRs and resolving conflicts. The audit script was run twice minutes apart and reported different counts (direct=6 vs stale snapshot direct=9). Additionally, a referenced precedent (#498 help-flag guard) was initially believed to be at origin/main but only existed in an in-flight worktree merge, so citing it as "existing pattern" would have been incorrect.

**How to apply:** 
1. Use worktrees (per CLAUDE.md rule) for investigative work on features, not on main.
2. When reading facts during investigation on main (e.g., checking if a step exists in test.yml), use `git show origin/main:<path>` or `git ls-tree origin/main` rather than working-tree `cat`/`grep`.
3. Before citing a script or CI step as "an existing pattern" in recommendations, verify it exists at `origin/main` with `git show origin/main:<path>`, not just by seeing it in the current checkout.
4. If you must investigate on main and run side-effecting audits, restore the mutated files after each run with `git checkout -- <path>` and verify `git status` is clean before yielding control.
