---
name: shallow-clone-forensics-trap
description: "Local data-repo clones are depth-1 shallow — git log/merge-base give false 'history rewritten' or 'commit not ancestor' verdicts. Verify remote state via gh api commits/compare, never a shallow clone."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 110bb3d2-de33-4e87-827b-05038a7957fa
---

During the 2026-07-13 push-core-data incident, the local `~/broadway-scorecard-data` clone (depth-1, as created by setup scripts and CI patterns) produced two false forensic conclusions: `git log origin/main` showed exactly 1 commit ("history was nuked to an orphan commit") and `git merge-base --is-ancestor <sha> origin/main` returned false for a commit that WAS an ancestor. Both artifacts of shallowness, not remote state. ~20 minutes were spent on a force-push/history-rewrite hypothesis that was wrong.

**Why:** shallow clones have grafted history; ancestry queries and log depth reflect the local graft point, not the real remote graph.

**How to apply:** When investigating "my commit disappeared" or "history looks rewritten" in ANY repo cloned by this project's tooling (data repo, review-texts — both use `--depth 1`), do remote-truth checks FIRST:
- `gh api repos/<owner>/<repo>/commits?per_page=10` — real recent history
- `gh api repos/<owner>/<repo>/commits/<sha>` — does the commit exist remotely
- `gh api repos/<owner>/<repo>/compare/<sha>...<head>` — `status: ahead` proves ancestry; `.files[]` shows which later commits touched a given path
- `gh api repos/<owner>/<repo>/events` — PushEvents with `forced` flag reveal real force-pushes

Related: [[feedback_dual_repo_data_files]], [[feedback_data_repos_clobber_uncommitted]].
