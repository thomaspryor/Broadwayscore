---
name: feedback-workflow-dispatch-ref-for-unmerged-ci-script
description: "To live-fire test an unmerged change to a workflow_dispatch-triggered script before merging to main, dispatch with --ref <feature-branch> — main's code otherwise runs regardless of what you just wrote."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: af517824-28ca-4cac-a629-ff725befe761
---

`workflow_dispatch` checks out and executes whatever code is on the given `ref` at dispatch time — not necessarily main. This is easy to forget when validating a change to the *script itself* (e.g. `scripts/autonomous-merge.js`, run by `.github/workflows/autonomous-merge.yml`): dispatching against `main` before merging just re-runs the OLD code, and any bug in your new logic won't surface.

**Why:** During the autonomous nightly loop Sprint 4 build (2026-07-14), a live-fire test of a new Tier-2 CI merge path needed real proof the new code worked before merging. Dispatching with `-r <worktree-branch-name>` ran the branch's actual code — this is how a real bug (missing git committer identity on a fresh clone) got caught and fixed *before* it ever reached main, across 3 real dispatch attempts, each iterated on locally first to avoid burning a ~15-20min CI round-trip per guess.

**How to apply:**
- `gh workflow run <workflow>.yml --ref <feature-branch> -f input=value ...` runs that branch's version of both the `.yml` and any script it invokes.
- Push the feature branch first (workflow_dispatch needs the ref to exist on the remote).
- Before re-dispatching after a fix, reproduce the failure locally if possible (e.g. re-run the underlying script directly against a local clone) — much cheaper than another full CI round-trip.
- Merge to main only after a real dispatch against the branch succeeds — this is a stronger signal than any unit test for scripts whose job IS orchestrating git/CI/API side effects.

Related: [[feedback_main_test_yml_cancelled_dispatch_to_verify]], [[feedback_github_polling_rate_limit]].
