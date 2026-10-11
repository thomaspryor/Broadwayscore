// BRO-5042: scope review-file errors to checkout-time bytes, including files
// committed by the job before validation. Missing scope always fails closed.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { listShowDirs } = require('./list-show-dirs');
const { criticKey } = require('./manual-entry-merge');
const { normalizeOutlet } = require('./review-normalization');
const BASELINE_NAME = '.review-validation-baseline.json';
function fingerprint(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function snapshotReviews(reviewDir, baselineFile) {
  const files = {};
  for (const dir of listShowDirs(reviewDir)) {
    if (dir === 'aggregator-archive') continue;
    for (const file of fs.readdirSync(path.join(reviewDir, dir))) {
      if (file.endsWith('.json')) files[`${dir}/${file}`] = fingerprint(path.join(reviewDir, dir, file));
    }
  }
  fs.writeFileSync(baselineFile, JSON.stringify({ version: 1, files }));
  return Object.keys(files).length;
}
function reviewKey(showId, review) {
  return JSON.stringify([showId, normalizeOutlet(review.outletId || review.outlet),
    criticKey(review.criticName), review.url || null]);
}
function createReviewValidationScope(reviewDir, baselineFile, reviewsBaselineFile) {
  let baseline;
  try {
    const data = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    if (data.version === 1 && data.files && typeof data.files === 'object') baseline = data.files;
  } catch { /* unknown scope retains the blocking error */ }
  const baselineRows = new Map();
  try {
    for (const row of JSON.parse(fs.readFileSync(reviewsBaselineFile, 'utf8')).reviews) {
      const key = reviewKey(row.showId, row);
      const rows = baselineRows.get(key) || [];
      rows.push(row);
      baselineRows.set(key, rows);
    }
  } catch { baselineRows.clear(); /* unknown derived scope retains blocking errors */ }
  const quarantined = new Map();
  function reportRowError(message, review, { error, warn }) {
    const key = reviewKey(review.showId, review);
    if (!(baselineRows.get(key) || []).some(row => isDeepStrictEqual(row, review))) {
      error(message);
      return;
    }
    quarantined.set(key, { showId: review.showId, review });
    warn(`[unchanged-review] ${message}; excluded from this core-data save, source row needs repair`);
  }
  function reportError(message, relativeFile, review, { error, warn }) {
    let unchanged = false;
    if (relativeFile && baseline && /^[^/]+\/[^/]+\.json$/.test(relativeFile)) {
      try { unchanged = baseline[relativeFile] === fingerprint(path.join(reviewDir, relativeFile)); }
      catch { /* retain the blocking error */ }
    }
    if (!unchanged) { error(message); return; }
    quarantined.set(relativeFile, { showId: relativeFile.split('/')[0], review });
    warn(`[unchanged-review] ${message}; excluded from this core-data save, source file needs repair`);
  }
  function excludeQuarantinedReviews(data) {
    // Match normalized outlet and byline as well as show and URL, so a
    // legitimate second critic sharing the same article is preserved.
    const excluded = new Set([...quarantined.values()]
      .map(({ showId, review }) => reviewKey(showId, review)));
    const reviews = data.reviews.filter(r => !excluded.has(reviewKey(r.showId, r)));
    const filtered = { ...data, reviews };
    if (reviews.length !== data.reviews.length && data._meta?.stats) {
      filtered._meta = { ...data._meta, stats: { ...data._meta.stats, totalReviews: reviews.length } };
    }
    return filtered;
  }
  return { reportError, reportRowError, excludeQuarantinedReviews, quarantined };
}
module.exports = { BASELINE_NAME, snapshotReviews, createReviewValidationScope };
if (require.main === module) {
  const [reviewDir, baselineFile] = process.argv.slice(2);
  if (!reviewDir || !baselineFile) throw new Error('Usage: review-validation-scope.js <review-dir> <baseline-file>');
  console.log(`Review validation baseline: ${snapshotReviews(reviewDir, baselineFile)} files`);
}
