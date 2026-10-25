---
name: feedback_push_survival_check_false_positive
description: "push-with-retry.sh's content-survival check can print \"N/N confirmed surviving\" while a merge-conflict resolution was silently reverted underneath it — verify manually after any non-trivial conflict resolution."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 317f5dd9-6f4a-471e-bc40-5420cceebc6f
  modified: 2026-08-14T22:47:57.831Z
---

After resolving real merge conflicts (not just data-file auto-merges) and pushing via `scripts/lib/push-with-retry.sh`, its rebase-conflict "auto-resolution" or "reset + cherry-pick" fallback can silently revert a file back to pre-resolution content — even while the script's own post-push content-survival check (`push-content-survival.js`) prints "OK — N/N modified file(s) confirmed surviving on origin/main" and the overall push reports success.

**Why:** `push-content-survival.js` classifies survival by comparing blob hashes at three points (base/local/final). When final content matches neither base nor local ("ambiguous" — e.g. a 3-way merge folding in a concurrent unrelated change), it's deliberately NOT flagged as failure by design, only "surfaced for visibility." A deep-check (task #833, `addedLinesSurvived`) exists to catch some of these, but a full function-body replacement (not just added lines) can still slip through as a false "confirmed surviving." Reproduced live 2026-08-14 on BRO-218: two files (`scripts/scrape-cast-changes.js`, `.github/workflows/test.yml`) had merge-resolution content reverted to pre-resolution state across two separate push-with-retry runs, both reporting clean survival; only CI (`Lint Workflows` red on an unrelated baseline check) caught it. Follow-up investigation card #1539.

**How to apply:** after any push-with-retry run that involved resolving a real merge conflict (not a trivial data-file auto-merge), don't trust the "confirmed surviving" line alone. Run `git show origin/main:<file>` on each conflict-resolved file directly and compare against your intended resolution before considering the push verified. Cheap insurance: re-run the specific check your change was meant to fix (e.g. a lint/audit script) against origin's content, not just local.
