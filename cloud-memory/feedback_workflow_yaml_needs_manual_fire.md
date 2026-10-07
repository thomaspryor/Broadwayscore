---
name: New workflow YAML needs a manual-fire smoke test before scheduled cron
description: 6 reviewers (4 Claude agents + Codex + GPT-4o) reviewing the YAML statically all missed the missing `git config user.name/email` in a commit step that crashed every run with "empty ident name". Only manual-fire surfaced it.
type: feedback
originSessionId: beeab90a-2eb2-4817-b850-1b6881564dde
---
When you ship a new GitHub Actions workflow that contains an inline `git commit` step (NOT through a composite action that already sets identity), do `gh workflow run <name>` BEFORE the first scheduled cron fires. Static review by humans/LLMs/Codex will not catch the missing `git config user.name/email` because (a) the workflow YAML reads correctly, (b) the failure mode is environmental — the bare workspace inherits no git identity by default.

**Why:** caught 2026-04-29 in `enrich-off-broadway-dates.yml` (run 25143060961, exit code 128, `fatal: empty ident name (for <runner@runnervm...>) not allowed`). The 6-reviewer plan-review pass + ship-check pass had all flagged design issues but none caught this — it only manifests at execution time.

**How to apply:**
1. Before any new workflow's first scheduled fire, manually trigger via `gh workflow run <name>` (use a low-impact mode like `--mode=verify` or `--dry-run` if available).
2. If the workflow has an inline `git commit` step, verify it sets `git config user.name "GitHub Action"` and `git config user.email "action@github.com"` BEFORE the commit. Composite actions (push-core-data, push-review-texts) already do this — only inline commits in the workflow YAML are at risk.
3. If the manual-fire fails, fix BEFORE merging the workflow rather than waiting for the cron.

**Don't trust:** static review (LLM or human), `actionlint`, or `npx tsc --noEmit` to catch this class of bug. They all passed in the 2026-04-29 incident.
