---
name: branch-protection-direct-push
description: "GitHub branch protection's \"Required status checks\" gates PR merges only — direct pushes go through even when checks fail or get cancelled"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a31f4cef-d4fa-40ec-bd4d-c390619e6577
---

GitHub branch protection's `required_status_checks` setting only gates **PR merges**. It does NOT block direct pushes to the protected branch, even when:
- The required check failed
- The required check was cancelled by a newer push
- The required check never ran (e.g., paths-filter on the workflow excluded the commit's paths)

**Why:** Verified empirically on 2026-05-23 — commit `a88d4334c6` landed on main with `Data Validation: failure` + `E2E Tests: failure` on test.yml. My own commit `d1d00d36f4` landed with all required checks "cancelled" by a subsequent push.

**How to apply:**
- When telling the user that branch protection "blocks broken code," qualify it: only on PR merges. Direct pushes are not gated by required status checks. They ARE blocked by:
  - `allow_force_pushes: false` (force-push blocked)
  - `allow_deletions: false` (branch deletion blocked)
  - `enforce_admins: true` + `required_pull_request_reviews` (would require PRs)
- If the user wants true gate enforcement for direct pushes, the only path is requiring PRs (no direct pushes). The current Broadway Scorecard workflow is direct-push to main, so "required status checks" gives them less than I initially implied.

**The actual benefit of the protection I enabled on 2026-05-23 (main):**
- Force-push: blocked ✅
- Branch deletion: blocked ✅
- PR merges: must pass `TypeScript Check` + `Unit Tests` ✅
- Direct pushes: not gated by status checks (visible red X only) ❌

See also: [[worktree-code-changes]] for the related discipline of using worktrees.
