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
 * @param {boolean} [opts.skipHolding=false] - skip _-prefixed holding directories
 *   when directory names represent show IDs. Leave false for whole-corpus
 *   forensic scans and backups that need archived/quarantined records too.
 * @returns {string[]} subdirectory names (not full paths)
 */
function listShowDirs(dir, opts = {}) {
  const { silent = false, skipHolding = false } = opts;
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
    if (skipHolding && name.startsWith('_')) continue;
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

/**
 * A whole-corpus audit needs the WHOLE review-texts corpus. A sparse or
 * partial checkout (e.g. a cloud session's attached clone that unpacked only
 * the 29 shows it touched) still passes an "exists and non-empty" check, and
 * every show outside it then reads as having zero collected reviews.
 * 2026-10-31 (BRO-6687): a local gap-audit catch-up pointed at such a clone
 * saw live counts drop to 0 on 348 shows; only the blast-radius guard stopped
 * the write. Floor matches audit-aggregator-coverage.js's existing 200 check.
 *
 * @param {string} dir
 * @param {number} [minShowDirs=MIN_CORPUS_SHOW_DIRS]
 * @returns {string|null} a human-readable problem, or null when the dir looks whole
 */
const MIN_CORPUS_SHOW_DIRS = 200;
function corpusDirProblem(dir, minShowDirs = MIN_CORPUS_SHOW_DIRS) {
  if (!dir || !fs.existsSync(dir)) return `review-texts dir missing: ${dir}`;
  const n = listShowDirs(dir, { silent: true, skipHolding: true }).length;
  if (n === 0) return `review-texts dir is empty: ${dir}`;
  if (n < minShowDirs) return `review-texts dir has only ${n} show folder(s) (expected ${minShowDirs}+): ${dir}. likely a partial or sparse checkout`;
  return null;
}

module.exports = { listShowDirs, corpusDirProblem, MIN_CORPUS_SHOW_DIRS };
