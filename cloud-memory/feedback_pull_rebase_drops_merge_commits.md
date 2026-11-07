---
name: feedback_pull_rebase_drops_merge_commits
description: "git pull --rebase silently drops merge commits, losing worktree work from a push"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4a573bec-1b5a-4b1e-a949-0f5020b97aa6
---

A merge commit on local `main` (from merging a worktree branch) is SILENTLY DROPPED by `git pull --rebase` — default rebase linearizes first-parent history and discards merge commits, so the side-branch changes never reach origin. The push then "succeeds" with a clean `main -> main` line while your work is missing. A `git config pull.rebase/pull.ff` setting does NOT prevent this when you pass `--rebase` explicitly (the flag overrides config).

**Why:** 2026-06-21 — merged `worktree-scraper-cost-cut` into main; push blocked by a transient GitHub DNS outage (`Could not resolve host`, not a rate limit, not GitHub down). The retry used `git pull --rebase`, which dropped the merge commit; the push went out WITHOUT `scrapingdog-bakeoff.js` + the telemetry. Only caught by verifying file-by-file on origin (`git cat-file -e origin/main:path`). A note alone is weak prevention — the real fix is a helper that encodes the safe sequence and verifies files landed.

**How to apply:** To integrate blocked/diverged worktree work, ALWAYS use `git merge` (fetch → `git merge origin/main` → `git merge <branch>`), NEVER `git pull --rebase`. After pushing, VERIFY the actual files are on origin (`git show origin/main:path | grep` or `git cat-file -e`), not just the push exit line. If a background daemon keeps rewriting data/audit + cloud-memory files and blocks the merge, chain `git stash push -m x && git merge ...` in one command to beat the write race, then `git checkout HEAD -- <daemon dirs>` on pop conflict. Prefer a `scripts/merge-worktree-to-main.sh` helper that does all of this in one verified step. See [[feedback_data_repos_clobber_uncommitted]], [[feedback_worktree_code_changes]].

**Sibling bug — push-success check by grep is a false-positive trap (2026-06-21, same session):** A retry loop that decided success with `git push ... | grep "main -> main"` FALSELY matched the REJECTION line (`! [rejected]   main -> main (fetch first)` contains that exact substring), so a rejected push reported "PUSHED" while Phase 2 of the rollout never reached origin. Ground-truth oracle for "did the push land" is `git merge-base --is-ancestor HEAD origin/main` AFTER a confirmed `git fetch` — never a substring of push stdout. Guard the ancestor check on a successful fetch (retry the fetch a few times first); a failed fetch leaves the remote-tracking ref stale and the ancestor test then false-FAILS an otherwise-good push. Both bugs share one root: **trusting a status string instead of verifying the object actually exists on origin.** When the local tree is mid-merge from a parallel session and you can't push, land a single verified file via `gh api -X PUT /contents/` (base64 unwrapped: `base64 -i f | tr -d '\n'`) — see [[feedback_gh_api_emergency_commit]].
