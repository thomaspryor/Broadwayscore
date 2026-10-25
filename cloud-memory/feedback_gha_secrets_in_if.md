---
name: GHA secrets context not available in step if conditions
description: GitHub Actions secrets context cannot be used in step-level if conditions — causes workflow dispatch to fail with 422
type: feedback
---

Never use `secrets.X` in a step-level `if:` condition in GitHub Actions workflows. It causes a 422 "Unrecognized named-value" error when dispatching the workflow.

**Why:** GHA only allows `secrets` in `env:` and `with:` blocks, not in conditional expressions. The error only surfaces at dispatch time, not at push.

**How to apply:** If a step should be conditional on a secret existing, either (1) have the script itself handle the missing key gracefully and always run the step, or (2) set the secret value as an env var in a prior step and check that env var in the `if:` condition.
