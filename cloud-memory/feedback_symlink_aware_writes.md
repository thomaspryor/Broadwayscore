---
name: fs.renameSync/writeFileSync on data/reviews.json must resolve symlinks first
description: Local dev keeps data/reviews.json + data/shows.json as symlinks to ~/broadway-scorecard-data. Any script that writes these MUST resolve through realpathSync or the symlink is replaced with a regular file, breaking single-source-of-truth.
type: feedback
originSessionId: b2cc6d5f-5eb0-4c16-b1ec-8702cae1481a
archived: true
---
**The rule:** Any script that writes `data/reviews.json` (or any file in `SYMLINK_FILES` from setup-local-data.sh) must resolve the path through `fs.realpathSync()` before `renameSync` / `writeFileSync`. If not, the atomic rename REPLACES the symlink with the tmp file and the single-source-of-truth contract breaks.

**Why (actual failures, 2026-04-22 session):**
Hit this twice during the Schmigadoon TB rescue. After each local `node scripts/rebuild-all-reviews.js` run:
1. `data/reviews.json` went from symlink → regular file
2. Next `npx tsc --noEmit` failed with `Cannot find module '../../data/shows.json'` on 6 files (src/lib/data-*.ts) because the sibling symlink chain was broken
3. Next `node scripts/validate-data.js` crashed with `shows.json does not exist`
4. I manually re-linked, got bitten again when a second rebuild ran

The atomic tmp+rename pattern (`fs.renameSync(reviewsTmpPath, reviewsJsonPath)`) is POSIX-correct but violates the symlink invariant. setup-local-data.sh intentionally symlinks these files so local edits write THROUGH to the private repo (feedback_dual_repo_data_files.md).

**How to apply:**

For new code writing `data/reviews.json` / `data/shows.json` / other symlinked data files:

```js
let targetPath = reviewsJsonPath;
try { targetPath = fs.realpathSync(reviewsJsonPath); } catch (_) {/* first-time write */}
try {
  fs.renameSync(reviewsTmpPath, targetPath);
} catch (renameErr) {
  if (renameErr.code === 'EXDEV') {
    // Cross-filesystem (worktree + iCloud sync target). Two-hop for atomicity:
    // copy to a tmp NEXT TO the target (same FS), then atomic rename.
    const targetDir = path.dirname(targetPath);
    const sameFsTmp = path.join(targetDir, '.cross-dev.tmp');
    fs.copyFileSync(reviewsTmpPath, sameFsTmp);
    fs.renameSync(sameFsTmp, targetPath);
    fs.unlinkSync(reviewsTmpPath);
  } else { throw renameErr; }
}
```

For a fallback when realpathSync throws, use `path.resolve(__dirname, '..', 'data/...')` — NOT a bare relative string (writeFileSync resolves relative to process.cwd() which isn't always the repo root).

**Current writers of reviews.json that already do this (as of 2026-04-22):**
- `scripts/rebuild-all-reviews.js:3790` (fixed in c3a86e1f8c, hardened in eaf1768671)
- `scripts/assign-scores-from-quotes.js:176` (fixed in c3a86e1f8c, hardened in eaf1768671)

**What to do if `ls -la data/reviews.json` shows a regular file instead of a symlink:**
```bash
rm data/reviews.json
ln -s /Users/tompryor/broadway-scorecard-data/reviews.json data/reviews.json
# For worktrees, also symlink data/shows.json and data/review-texts/
```

**Related:**
- [feedback_dual_repo_data_files.md](feedback_dual_repo_data_files.md) — why these files are symlinks
- [feedback_reviews_json_dual_repo_push.md](feedback_reviews_json_dual_repo_push.md) — push etiquette for the derived file
