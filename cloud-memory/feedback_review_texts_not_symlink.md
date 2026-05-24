---
name: data/review-texts is NOT a symlink
description: Unlike reviews.json/shows.json, data/review-texts/ is a REGULAR directory in the main repo, independent of ~/broadway-review-texts. Local writes don't propagate.
type: feedback
originSessionId: a0578512-e6e0-4e93-81e8-4bb716033bb9
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
