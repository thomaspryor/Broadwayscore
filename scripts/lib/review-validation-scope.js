// BRO-5042: scope review errors to unchanged reviews AND show records at
// checkout, including files committed by the job. Missing scope fails closed.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { listShowDirs } = require('./list-show-dirs');
const { criticKey } = require('./manual-entry-merge');
const { normalizeOutlet } = require('./review-normalization');
const { DEFAULT_SNAPSHOT_PATH, loadBaselineShows, computeChangedShowIds } = require('./shows-since-checkout-diff');
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
function createReviewValidationScope(reviewDir, baselineFile, reviewsBaselineFile, {
  showsFile = path.join(reviewDir, '..', 'shows.json'),
  showsBaselineFile = DEFAULT_SNAPSHOT_PATH,
} = {}) {
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
  let unchangedShowIds;
  function showIsUnchanged(showId) {
    // Read lazily: validate-data's show auto-fixes run before review checks.
    // A changed date, credit or market can create errors in untouched reviews.
    if (!unchangedShowIds) {
      unchangedShowIds = new Set();
      try {
        const before = loadBaselineShows(showsBaselineFile);
        const data = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
        const current = data.shows || data;
        const validShows = rows => Array.isArray(rows) && rows.every(s => s && typeof s.id === 'string')
          && new Set(rows.map(s => s.id)).size === rows.length;
        if (validShows(before) && validShows(current)) {
          const changed = new Set(computeChangedShowIds(before, current));
          unchangedShowIds = new Set(before.filter(s => !changed.has(s.id)).map(s => s.id));
        }
      } catch { /* missing/unreadable show scope retains the blocking error */ }
    }
    return unchangedShowIds.has(showId);
  }
  const quarantined = new Map();
  function reportRowError(message, review, { error, warn }) {
    const key = reviewKey(review.showId, review);
    if (!showIsUnchanged(review.showId)
      || !(baselineRows.get(key) || []).some(row => isDeepStrictEqual(row, review))) {
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
    const showId = relativeFile?.split('/')[0];
    if (!unchanged || !showIsUnchanged(showId)) { error(message); return; }
    quarantined.set(relativeFile, { showId, review });
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
