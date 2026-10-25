---
name: feedback_verify_private_repo_push_via_reclone
description: "After writing to a private core-data repo (outlet-registry.json, etc.), verify the push landed by independently re-cloning — a local gitignored copy looking correct is not proof it reached origin"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4ac2e855-22e5-4ec2-87ba-0735e5abd42a
  modified: 2026-08-20T16:56:15.779Z
---

When a script writes to a gitignored local copy of a private core-data file (outlet-registry.json, shows.json, reviews.json) and the local copy looks correct, that is NOT evidence the change reached the private repo (`thomaspryor/broadway-scorecard-data`) that CI and production actually read from.

**Why:** task #1838 (outlet-alias-collision guard) ran a merge script against a scratchpad clone, but copied the result into a worktree's `data/` dir and verified success there — never actually `git commit && git push`ed the scratchpad clone itself. Local tests passed, the fix looked shipped, but the private repo was untouched. Caught only because a dispatched review subagent independently fetched the private repo fresh and diffed it.

**How to apply:** after any write intended to land in a private core-data repo — clone fresh (or `git pull` a known-clean clone), commit, push, THEN re-clone independently (a second fresh clone, not the one you just pushed from) and assert the change is present before treating the task as done. Don't trust "my local copy shows the merged state" as proof of anything beyond your own local copy. See [[feedback_dual_repo_data_files.md]] for the broader dual-repo pattern this is a specific instance of.
