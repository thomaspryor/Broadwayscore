'use strict';

const fs = require('fs');
const path = require('path');

const name = 'review-count-match';
const description = 'Local review-texts file count matches reviews.json count (exclusion drift detection)';

const WARN_THRESHOLD = 1;
const ERROR_THRESHOLD = 5;

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);

  if (!fs.existsSync(showDir)) {
    // No review-texts dir yet — normal pre-opening
    return { ok: true, severity: 'ok', message: 'No review-texts directory yet — skipping count check' };
  }

  let localFiles;
  try {
    localFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const localCount = localFiles.length;
  const builtCount = (context.reviewsDoc[show.id] || []).length;
  const gap = localCount - builtCount;

  if (gap <= 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `review-texts (${localCount}) matches reviews.json (${builtCount}) — no exclusion drift`,
    };
  }

  // gap > 0: local files exist that were excluded from rebuild
  const severity = gap >= ERROR_THRESHOLD ? 'error' : 'warning';
  const cmd = `node scripts/rebuild-all-reviews.js --show=${show.id} --verbose 2>&1 | grep EXCLUSION`;

  return {
    ok: false,
    severity,
    message: `${gap} local review file(s) excluded from rebuild (${localCount} local vs ${builtCount} in reviews.json); inspect with:\n${cmd}`,
    details: { localCount, builtCount, gap, showId: show.id },
  };
}

module.exports = { name, description, run };
