---
name: silent-merge-loss-on-reformat
description: A worktree branch with a large reformat/restructure on a JSON file silently loses additions in a 3-way merge when main has any concurrent edit to the same file. Ship-check tests catch it; the merge does not.
archived: true
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 405a75d7-f4ef-453c-b017-df5b3c38efcd
---

When a worktree branch reformats a tracked JSON file (e.g., adds a field to every entry, sorts keys differently, changes indent) AND main has any concurrent edit to that file (even a small one), git's 3-way merge **may silently choose main's side without surfacing a conflict.** The worktree's reformat-driven changes vanish from the merge result.

This happened on 2026-05-16 with S3-T1:
- Worktree commit cbf7e97c5c added `cvStyle` to every entry in `data/outlet-registry.json` (970-line reformat)
- Main concurrently received commit a96c583447 adding a single new alias to one outlet entry
- The S3 merge (4014d52077) had a conflict on test.yml (resolved manually), but **no conflict on outlet-registry.json** — git auto-merged and dropped all cvStyle additions
- Result: `getCvStyle('new-york-sun')` returned `'standard'` instead of `'long-biographical'` for ~30 minutes on production main
- The entire S3 defer-gate was a silent no-op
- Caught only because `/ship-check` re-ran the unit tests on main and `tests/unit/should-defer-cv-wrong-show.test.mjs` failed

**Why this is dangerous:** worktree per-task verification passes (the file IS correct in the worktree). Per-task reviewer subagent approves (commit looks good). The merge succeeds (no conflict markers). Push succeeds. **All gates green, all logic silently broken.**

**Rule:**
1. **Re-run the affected feature's unit tests on main AFTER merge**, not just on the worktree branch. If the unit tests cover the feature's data dependencies (outlet-registry, critic-registry, etc.), they catch silent merge loss. The S3 push-with-retry merge process must include a post-merge test pass on main HEAD before declaring victory.
2. **Be suspicious of merges that complete cleanly when the worktree branch has both reformatting AND additions on a file main also touched.** A perfectly clean merge in that scenario is the warning sign.
3. **Prefer surgical edits over reformat-driven changes for shared/often-touched files.** S3-T1's "add cvStyle to every entry" should have been "add cvStyle to the 5 long-biographical entries; let lookup default to standard for the rest." That smaller diff would have merged cleanly without losing tags. The fix that recovered the bug used this surgical pattern.
4. **Add a post-merge sanity check to the execute-plan skill:** after merging a sprint to main, re-run any unit tests whose subject was the sprint's primary deliverable. Update `/execute-plan` to include this gate (out of scope for this entry; file a separate card).

**How to apply:**
- When writing a `/plan-tasks` plan that includes adding a field to every entry of a JSON file (registries, configs), call out the merge-risk in the task description.
- Reviewer subagents on T-tasks that touch JSON registries should verify the additions are present in main's HEAD after merge, not just on the worktree branch.
- When `/ship-check` finds a test failure on main that the worktree's tests pass on, **always check for silent merge loss as a possible cause** before assuming the test is broken.

**Related:**
- [[feedback_parallel_worktree_race]] — different failure mode, same root issue (parallel sessions racing on shared files)
- [[feedback_silent_git_add_failures]] — adjacent class (CI git-add silently dropping files)
- [[feedback_silent_workflow_failures]] — adjacent class (workflows with silent error swallowing)
