---
name: silent-git-add-failures
description: git add of mixed paths with 2>/dev/null || true silently drops everything when one path errors — always stage paths individually or use nullglob arrays
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 405a75d7-f4ef-453c-b017-df5b3c38efcd
---

When a CI commit step writes `git add a b c d e 2>/dev/null || true`, expectations and reality diverge:

- **Expectation:** git stages a, b, c, d; errors on e; `|| true` keeps the workflow going.
- **Reality:** the entire command may exit non-zero before any path lands in the index — `git diff --cached --quiet` then returns 0 ("nothing to commit"), and the workflow silently skips the commit even though files DID change on disk.

This bit S4 twice on 2026-05-16:

1. `audit-critic-coverage.yml` listed 5 paths including `data/audit/critic-coverage-buckets.md` (gitignored via `/data/audit/**/*.md`). git add errored on the gitignored file → silent abort → first weekly snapshot never committed.
2. Same workflow's history-snapshot glob `data/audit/critic-coverage-history/*.json` worked fine in isolation but failed when bundled with the gitignored file.

**Why:** `|| true` only suppresses the EXIT CODE for the workflow shell. It does NOT undo any partial-staging behavior. With modern git, some pathspec errors abort the entire add operation before staging anything.

**Rule (CI commit steps):**
- Stage paths individually with per-path existence guards:
  ```bash
  for f in data/audit/critic-coverage-audit.json data/audit/critic-coverage-buckets.json; do
    [ -f "$f" ] && git add "$f" || echo "skip (missing): $f"
  done
  ```
- For globs, use nullglob arrays so the add command only runs when there's >= 1 match:
  ```bash
  shopt -s nullglob
  files=( data/audit/critic-coverage-history/*.json )
  shopt -u nullglob
  [ ${#files[@]} -gt 0 ] && git add "${files[@]}" || echo "skip (empty dir)"
  ```
- Add `git diff --cached --stat` between staging and the commit-gate `if` so a future failure is diagnosable in workflow logs.
- Never silence `git add` stderr with `2>/dev/null` — the error message is the diagnostic. Use `2>&1` or omit it; let the `|| true` handle the exit code.

**Why:** silent CI failures of this class are nearly invisible — the workflow returns success, the step output is empty, the only evidence is "missing file in main" days later. The cost of the per-path expansion is one extra commit line per file; the cost of the bug is hours of post-deploy debugging.

**How to apply:** any new `git add a b c ... 2>/dev/null || true` in a workflow PR is a code-review smell. Replace with the per-path/nullglob pattern. Especially in audit/digest workflows where partial commits look identical to "nothing changed."

**Related:**
- [[feedback_silent_workflow_failures]] — broader pattern of `|| true` masking diagnostics
- [[feedback_pipe_masks_exit_code]] — adjacent pipefail issue
