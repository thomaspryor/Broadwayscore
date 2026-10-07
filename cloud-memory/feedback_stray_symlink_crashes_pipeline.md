---
name: stray-symlink-committed-to-data-repo-crashes-readdir-stat-pipelines
description: A committed symlink with an absolute local target dangles in CI; readdirSync→statSync iteration throws ENOENT and crashes the whole run. Guard both the commit (push action strips symlinks) and the consumer (listShowDirs tolerates bad entries).
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d2368b9-09cf-4535-a45c-a53c0a4105a2
---

**Rule:** Never let a symlink get committed to the review-texts / core-data private repos, and never iterate a review-texts directory with a raw `readdirSync(dir).filter(f => statSync(join(dir,f)).isDirectory())` — one dangling entry crashes the entire run.

**Why (2026-05-27 incident, self-inflicted):** During slug-misroute work I ran `git add -A` in `~/broadway-review-texts/` while a stray symlink `broadway-review-texts -> /Users/tompryor/broadway-review-texts` (absolute local path) sat in the working tree. It got committed + pushed. In CI that absolute path doesn't exist → dangling symlink. `collect-review-texts.js` did `fs.readdirSync(reviewTextsDir)` (lists the link name) then `fs.statSync` (follows it → ENOENT) → crash at line 5464. The 3×-daily collection pipeline failed 5 runs in a row over ~8h before anyone noticed (no per-run alert fired because the job "completed/failure" looks like any other red).

**Two-layer fix shipped (commit f9f023bdaf):**
- **Consumer:** `scripts/lib/list-show-dirs.js` → `listShowDirs(dir)`. Tolerates per-entry stat failures (dangling symlink, stray file, perm error): skips with a `::warning::`, re-throws ONLY if the dir itself is unreadable (returning `[]` would silently process zero shows — worse). Use this instead of the raw pattern. ~49 other scripts still use the raw pattern — migration tracked in Notion 36e637c5-...-e9964d19f342.
- **Root-cause guard:** `.github/actions/push-review-texts/action.yml` runs `find . -type l -not -path './.git/*' -delete` before `git add -A`. The data repo holds only JSON — a symlink there is always a mistake. The subsequent `git add -A` stages the removal (no separate `git rm --cached` — that form was unquoted and unsafe, caught by ship-check).

**How to apply:**
- After any `git add -A` in a data repo, sanity-check `git diff --cached --name-only --diff-filter=A` for symlinks before committing. Better: stage specific paths, not `-A`.
- `git ls-files -s | grep 120000` in a data repo lists tracked symlinks — should be empty.
- The public repo's `test.yml` lint-workflows job has a "Check for tracked symlinks or gitlinks" guard, but it only covers the PUBLIC repo, not the private data repos. The push-action strip is the private-repo guard.
- When a collection/audit script crashes with `ENOENT ... statSync ... data/review-texts/<name>`, suspect a dangling symlink named `<name>`, not a missing show dir.

**Related:** [[data/review-texts is NOT a symlink]] (the repos sync via CI actions, not symlinks — which is exactly why a committed symlink is never legitimate). [[CI step short-circuits colocated tests]] (the test that would have caught this only runs after the tests/unit batch, which was already red).
