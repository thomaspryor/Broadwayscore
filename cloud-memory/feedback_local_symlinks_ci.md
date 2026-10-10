---
name: Local symlinks break CI silently
description: "Mode 120000 entries break cp -f; check git ls-files --stage."
type: feedback
originSessionId: 7db74cc2-13a5-4bf5-aa34-d42de500ab54
archived: true
---
Never commit symlinks to local paths — they become dangling symlinks in CI. `cp -f` refuses to write through dangling symlinks, causing silent cascading failures.

**Why:** data/reviews.json was a symlink to ~/broadway-scorecard-data/reviews.json for local convenience. It was already in .gitignore but got tracked anyway (gitignore doesn't apply to already-tracked files). This broke 5+ workflows for hours on 2026-03-29. Recurrence 2026-04-22: a symlink `broadway-review-texts → /Users/tompryor/broadway-review-texts` was committed to the root of the **private review-texts repo** (not the public one). `collect-review-texts.js readdirSync` returned it, `statSync` threw ENOENT, and every collect-review-texts run failed for 8+ hours. The public repo's `.gitignore` doesn't protect private-repo contents.

**How to apply:** (1) Verify symlinks are not tracked in ALL repos, not just the public one: `git -C <repo> ls-files --stage | grep "^120000"` for `Broadwayscore/`, `broadway-review-texts/`, and `broadway-scorecard-data/`. (2) Never use `git add -A` or `git add .` in the private repos — they typically lack matching `.gitignore` coverage. (3) The checkout-core-data action has a defensive symlink removal loop for the public repo; the private repos don't. Consider adding a defensive filter in `collect-review-texts.js findReviewsToProcess()` so readdirSync output is filtered to `isDirectory()` via `lstatSync` that returns `false` on broken symlinks — a future reintroduction would fail-open instead of fatal-error the whole run.
