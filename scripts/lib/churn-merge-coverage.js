'use strict';

/**
 * Pure classification logic for the churn-vs-merge-attribute coverage monitor
 * (scripts/audit-churn-merge-coverage.js).
 *
 * No git/fs side effects — the CLI gathers per-file churn counts + .gitattributes
 * attribute values from git and feeds plain data in here. That keeps the decision
 * boundary unit-testable without a git fixture (CLAUDE.md §15).
 *
 * The monitor answers one question: which high-churn TRACKED files would conflict
 * on a human's bare `git merge` because they lack a merge driver? A file is:
 *   - covered  → has a real `merge` attribute (ours/union/…); no human conflict.
 *   - exempt   → no merge driver, but explicitly marked `merge-coverage=exempt`
 *                in .gitattributes (served/human-editable → needs a real 3-way
 *                merge, OR cross-run accumulate-state with no clean driver). The
 *                exemption is declared next to the merge policy it documents.
 *   - flagged  → high churn, no merge driver, not exempt → genuine "you forgot a
 *                merge attribute" candidate. This is the actionable signal.
 *
 * `merge-coverage` is a CUSTOM git attribute: git ignores it for merging, the
 * audit reads it via `git check-attr`. Keeping the exemption list in
 * .gitattributes (not hardcoded here) means exempting a file is a one-line data
 * change next to the merge drivers, and the source of truth stays singular.
 */

const EXEMPT_VALUE = 'exempt';

// `git check-attr` reports an unset attribute as the literal string 'unspecified'
// (and 'unset' for an explicit `-attr`). Treat both as "no driver".
function hasMergeDriver(mergeAttr) {
  return Boolean(mergeAttr) && mergeAttr !== 'unspecified' && mergeAttr !== 'unset';
}

function isExempt(coverageAttr) {
  return coverageAttr === EXEMPT_VALUE;
}

/**
 * @param {object}   opts
 * @param {Array}    opts.files     [{ path, churn, mergeAttr, coverageAttr }]
 * @param {number}   opts.minChurn  inclusive churn floor for a file to be considered
 * @returns {{ flagged, exempt, covered, summary }}
 */
function classifyChurnCoverage({ files, minChurn }) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (!Number.isFinite(minChurn)) throw new TypeError('minChurn must be a finite number');

  const flagged = [];
  const exempt = [];
  const covered = [];

  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    const churn = Number(f.churn) || 0;
    if (churn < minChurn) continue;

    if (hasMergeDriver(f.mergeAttr)) {
      covered.push({ path: f.path, churn, mergeAttr: f.mergeAttr });
    } else if (isExempt(f.coverageAttr)) {
      exempt.push({ path: f.path, churn });
    } else {
      flagged.push({ path: f.path, churn });
    }
  }

  const byChurnDesc = (a, b) => b.churn - a.churn || a.path.localeCompare(b.path);
  flagged.sort(byChurnDesc);
  exempt.sort(byChurnDesc);
  covered.sort(byChurnDesc);

  return {
    flagged,
    exempt,
    covered,
    summary: {
      minChurn,
      flaggedCount: flagged.length,
      exemptCount: exempt.length,
      coveredCount: covered.length,
      highChurnTracked: flagged.length + exempt.length + covered.length,
    },
  };
}

module.exports = { classifyChurnCoverage, hasMergeDriver, isExempt, EXEMPT_VALUE };
