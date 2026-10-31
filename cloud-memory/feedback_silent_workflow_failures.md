---
name: Silent workflow failure patterns
description: "Never `|| true` on git push/commit; use `|| echo \"::warning::...\"`."
type: feedback
---

Two dangerous patterns in GitHub Actions workflows:

1. `git push || true` silently drops data when push fails. Replace with `git push || echo "::warning::Push failed"` — same non-failing behavior but visible in logs.

2. `git config user.email/name` must be set in EVERY step that commits, not just the first one in a job. Later steps (like "Record pipeline success") run in the same runner but may not inherit config if the step is conditional (`if: success()`).

**Why:** These two patterns caused a 13-day health check error streak and 34-day pipeline staleness that went unnoticed. The `|| true` made failures invisible.

**How to apply:** When reviewing or writing workflow steps that do git commit/push, always check: (1) is git config set in THIS step? (2) is the failure handler `|| echo "::warning::..."` not `|| true`?
