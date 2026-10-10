/**
 * Safe directory listing for review-texts (and similar) show folders.
 *
 * The pervasive pattern across ~50 scripts is:
 *   fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory())
 *
 * That `statSync` throws (ENOENT) on a DANGLING SYMLINK — readdir lists the
 * link name, but stat follows it to a missing target and throws. One bad
 * entry crashes the entire run. This happened 2026-05-27: a stray
 * `broadway-review-texts -> /Users/tompryor/broadway-review-texts` symlink
 * (absolute local path) was committed into the private repo, dangled in CI,
 * and took down the 3×-daily collection pipeline for ~8h.
 *
 * listShowDirs() tolerates per-entry failures: a broken symlink, a stray
 * file, or a permission error skips that entry (with a ::warning::) instead
 * of throwing. The pipeline degrades gracefully on one bad entry rather than
 * failing wholesale.
 */

const fs = require('fs');
const path = require('path');

/**
 * Return the names of immediate subdirectories of `dir`, skipping:
 *   - non-directories (stray files like failed-fetches.json)
 *   - dangling symlinks (statSync throws ENOENT)
 *   - dotfiles / .git
 *   - any entry whose stat throws for any reason
 *
 * @param {string} dir - absolute or cwd-relative directory path
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - suppress the per-skip ::warning::
 * @returns {string[]} subdirectory names (not full paths)
 */
function listShowDirs(dir, opts = {}) {
  const { silent = false } = opts;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    // The directory itself is missing/unreadable — that IS fatal; the caller
    // configured a bad path. Re-throw so it surfaces loudly.
    throw e;
  }
  const dirs = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;  // .git, .DS_Store, etc.
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);  // follows symlinks
    } catch (e) {
      // Dangling symlink or unreadable entry — skip, don't crash the run.
      if (!silent) {
        console.warn(`::warning::listShowDirs: skipping unstattable entry '${name}' in ${dir} (${e.code || e.message}). Likely a broken symlink — should not be committed to the data repo.`);
      }
      continue;
    }
    if (st.isDirectory()) dirs.push(name);
  }
  return dirs;
}

module.exports = { listShowDirs };
