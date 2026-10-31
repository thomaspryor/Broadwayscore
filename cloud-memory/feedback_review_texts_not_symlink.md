---
name: data/review-texts is NOT a symlink
description: Unlike reviews.json/shows.json, data/review-texts/ is a REGULAR directory in the main repo, independent of ~/broadway-review-texts. Local writes don't propagate.
type: feedback
originSessionId: a0578512-e6e0-4e93-81e8-4bb716033bb9
modified: 2026-08-19T17:37:13.259Z
---
`~/Broadwayscore/data/review-texts/` is a regular directory — NOT a symlink to `~/broadway-review-texts/`. This is unlike `data/reviews.json` and `data/shows.json`, which ARE symlinks to the core-data private repo. Writes to `data/review-texts/*/*.json` via scripts land locally only; they don't propagate to the private repo, and the next CI sync overwrites them.

**Why:** The two sync via CI actions (`.github/actions/checkout-review-texts/`), not symlinks. CI clones `thomaspryor/broadway-review-texts` into `data/review-texts/` during the data-validation job. Locally, the two are independent copies kept in rough sync by manual rsync or setup-local-data.sh.

**CI diagnosis gotcha:** CI clones the REMOTE private repo at run time, not your local copy. If local `~/broadway-review-texts/` has a fix that wasn't pushed, CI will still fail. Always `git fetch origin main && git -C ~/broadway-review-texts show origin/main:SHOW/FILE.json` to see what CI actually reads. A local `validate-data.js` run passes because it reads `data/review-texts/` (public repo copy), not `~/broadway-review-texts/`.

**How to apply:**
- If you need to persist changes to review-text files (contentTier, flag updates, etc.), edit in `~/broadway-review-texts/` directly and `git add/commit/push` there.
- If you're writing from a script in the main repo, write to BOTH copies OR only to `~/broadway-review-texts/` path and skip the main repo copy (it's gitignored and irrelevant).
- Before assuming local writes to `data/review-texts/` are persistent, verify: `ls -la data/review-texts` — if it's a regular directory (`d` in the mode), writes are local-only.
- Also watch for pre-existing merge conflicts in `~/broadway-review-texts/` (observed 2026-04-24: beaches-2026/ had 17 files in UU/AA state with no active MERGE_HEAD, leftover from a failed merge). `git status` in the private repo before writing to it.

**Discovered:** 2026-04-24 regex-FP reclassify session. Wrote 74 files to `data/review-texts/` expecting symlink propagation. Files changed locally, but next audit re-run reset them (likely CI rsync from private) and they never reached the private repo. Reverted local writes; filed follow-up card for applying via private repo directly.

**Gotcha check in the other direction:** `data/reviews.json` and `data/shows.json` ARE symlinks. Edits there DO write through to the private repo's working tree but still need `git add/commit/push` in `/Users/tompryor/broadway-scorecard-data/` to persist. See `feedback_dual_repo_data_files.md` for that case.

**Script default is ~/broadway-review-texts, NOT the repo copy (2026-07-11):** audit/fix scripts (e.g. `audit-review-url-clusters.js`) resolve `RT = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts')`. Two consequences: (1) a script "Applied" its fix but `git status` in `~/Broadwayscore/data/review-texts` shows clean — the writes landed in `~/broadway-review-texts`; check there. (2) NEVER audit corpus state from `~/Broadwayscore/data/review-texts` — it's a separate clone that was 656 commits stale on 2026-07-11 and showed already-deleted contamination as present. Audit from `~/broadway-review-texts` after `git pull`, or pass `REVIEW_TEXTS_DIR` explicitly.

**Worktrees have NO data/review-texts at all — symlinking it makes writes hit the REAL private repo directly (2026-08-19, BRO-53 session):** a fresh worktree checkout doesn't even have the local regular-directory copy described above. `scoring-delta.js`/`test-temporal-override-regression.js` fail with "review-texts dir not found" and suggest `ln -sf <main-repo>/data/review-texts data/review-texts` as the fix — but the main repo's own `data/review-texts` may itself already be symlinked to `~/broadway-review-texts` (varies by machine setup), so this can chain straight through to the live private repo with NO CI-sync buffer in between. Writing any test fixture into `data/review-texts/<show>/<file>.json` at that point writes directly into real production review data. Caught mid-session: a synthetic `nytimes--jesse-green.json` fixture landed as an untracked file in `~/broadway-review-texts/the-lost-boys-2026/` (a real show dir) before being spotted via `git status` there and deleted. **Rule: never write smoke-test fixtures under any path reachable through `data/review-texts` once a symlink is in place for verification — use an isolated `/tmp` path and pass the absolute file path directly to the function under test instead.** Remove the symlink when done (`rm -f data/review-texts` — it's just the link, not `rm -rf` which risks following through a trailing-slash form) and always `git status` in `~/broadway-review-texts` afterward to confirm no stray files were introduced.
