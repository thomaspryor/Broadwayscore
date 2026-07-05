---
name: gitattributes-merge-ours-semantics-driver-registration
description: merge=ours keeps the ON-branch side (data loss for hand-edited files); the per-path driver ≠ git merge -X ours strategy; unregistered driver silently no-ops into a conflict.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 18f7bfa1-1290-421d-b733-878793091095
---

Triaging bot-churned audit files under `.gitattributes merge=ours` (2026-06-25, Notion 38b637c5-416f-815d). Three non-obvious git facts, each verified with a clean-global merge simulation:

1. **`merge=ours` keeps the side of the branch you are ON, and silently DISCARDS the other side's changes** — it is NOT "smart latest-wins." Safe ONLY for bot-written, never-hand-edited files (each cron emits a complete fresh snapshot, so dropping a side is harmless). For human-editable/served data (`public/data/admin/locks.json` written by the admin lock-score API, `data/tony-*-odds.json`, `public/data/shows/*`) it is DATA LOSS, not conflict-avoidance. Exclude those — they need a real 3-way merge.

2. **The per-path `merge=ours` driver is a DIFFERENT mechanism from the strategy option `git merge -X ours` / `git rebase -X theirs`.** The driver fires on a plain `git merge` (humans). `push-with-retry.sh` (the CI bot path) uses `-X ours/-X theirs` STRATEGY options, which ignore per-path `merge=ours` attributes entirely. So "CI relies on the driver" is false — the driver only matters for a human's bare `git merge`. Don't claim CI needs it registered.

3. **An unregistered custom driver silently NO-OPS.** `merge=ours` requires `git config merge.ours.driver true` (set by `scripts/setup-local-data.sh`). Without it, git falls back to a normal 3-way merge and CONFLICTS on the very files the driver was meant to auto-resolve — zero error. `feature-flags.ts merge=ours` sat broken this way until 830c1f5b48. `union`/`text`/`binary` are git built-ins (no registration). 

**How to apply:**
- Adding `merge=ours` to a file? First confirm it is bot-only-written (grep its writers; check no human/API write path). If anything hand-edits it, do NOT use `merge=ours`.
- A `test.yml lint-workflows` guard ("Check .gitattributes merge drivers are registered") now fails the build if a custom driver lacks a `merge.<name>.driver` line in `setup-local-data.sh`. Built-in allowlist lives in that step.
- To prove merge-driver behavior, simulate with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` in a temp repo — otherwise the machine-global `merge.ours.driver` (from setup-local-data.sh) contaminates the "unregistered" case.

Related: [[feedback_data_repos_clobber_uncommitted.md]], [[feedback_test_yml_push_path_allowlist.md]].
