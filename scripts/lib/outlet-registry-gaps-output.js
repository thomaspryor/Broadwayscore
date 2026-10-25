/**
 * Output shaping for audit-outlet-registry.js's git-tracked report,
 * data/audit/outlet-registry-gaps.json (BRO-2747). Pure, so the test can
 * require() it without running the 60k-file scan.
 */
const path = require('path');

/**
 * Deep copy of `value` with every string that is an absolute path inside
 * `repoRoot` rewritten repo-relative (forward slashes). A report written from
 * a worktree and one written from the main checkout are then byte-identical.
 */
function relativizeRepoPaths(value, repoRoot) {
  const root = path.resolve(repoRoot) + path.sep;
  const walk = v => {
    if (typeof v === 'string') {
      return v.startsWith(root) ? v.slice(root.length).split(path.sep).join('/') : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** The gaps file is a report-mode artifact; the --strict CI gate and
 * --report-only never touch the working tree. */
function shouldSaveAuditResults({ strict = false, reportOnly = false } = {}) {
  return !strict && !reportOnly;
}

module.exports = { relativizeRepoPaths, shouldSaveAuditResults };
