---
name: feedback_shared_checkout_tmp_branch_push
description: "When a parallel session is active, never merge/pull in the shared main checkout — land commits from the worktree via a tmp branch + push HEAD:main with fetch-merge retry"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01818bd9-0b9c-4e6d-a366-7b1512af86c3
  modified: 2026-08-18T01:56:32.683Z
---

**What happened (2026-07-11):** landing worktree commits via `cd /Users/tompryor/Broadwayscore && git pull && git merge <branch> && git push` collided with a parallel session THREE ways in one day: a merge conflict on test.yml's giant batch line silently dropped my test registration (main went red on the orphan-test audit), a `fatal: Unable to write index` from racing the other session's index.lock, and a `UU` conflicted state I initially mistook for my own merge.

**How to apply:**
- Before touching the shared main checkout, check for parallel-session evidence: uncommitted tracked-file modifications you didn't make (e.g. `tests/unit/*.test.mjs`), or fresh unfamiliar commits on origin/main. If present, DO NOT pull/merge/commit in the shared checkout at all.
- Land from the worktree instead: `git fetch origin main && git checkout -B tmp-land origin/main && git merge <worktree-branch> --no-edit`, then push with retry: loop `git push origin HEAD:main`; on reject `git fetch && git merge origin/main --no-edit`, jittered sleep. Delete tmp branch after.
- **Update 2026-08-17:** `scripts/lib/push-with-retry.sh` now accepts a `HEAD:main` refspec directly — run `bash scripts/lib/push-with-retry.sh 7 HEAD:main` from the worktree itself (no tmp branch needed). It already does fetch/rebase-or-merge/retry AND acquires the machine-wide push mutex (`scripts/lib/push-mutex.sh`, keyed on `git-common-dir` — identical across the main checkout and every worktree, so it's safe against the exact concurrent-push race this file is about even when run from a worktree, not just the main checkout). Confirmed safe when `merge-worktree-to-main.sh` itself refuses because of a stale/live `MERGE_HEAD` stuck in the shared main checkout — that script's own `git merge --abort` remedy can't be run from a worktree-isolated session (blocked by hook), but this script needs no main-checkout access at all.
- After ANY conflict resolution on test.yml's unit-test batch line, verify your entries survived: `git show origin/main:.github/workflows/test.yml | grep -c <your-test-name>` — the orphan-test audit catches loss only on the NEXT push (red main).
- Single-file emergency when even the worktree is tangled: `gh api PUT /repos/.../contents/<path>` with the current sha (race-safe, no local state).

Related: [[feedback_parallel_worktree_race]], [[feedback_gh_api_emergency_commit]], [[feedback_data_repos_clobber_uncommitted]]
