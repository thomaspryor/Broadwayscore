'use strict';
/**
 * BRO-7160: does a show have reviews on disk whose full text was never fetched (or only partly)? The opening-night
 * poller ran its "Collect full text inline" step only when the poll wrote NEW files (any_new). A targeted poller run
 * after the fast lane releases (the post-lane sweep) usually finds nothing new, so reviews the lane or an aggregator
 * recorded with an excerpt, a stub or a truncated page were never collected. This is the per-show signal that lets
 * that run collect anyway.
 *
 * A file counts when: it is a review (not `_`-prefixed metadata), it has an http(s) URL, it carries no exclusion flag
 * (wrongProduction, wrongShow, isRoundupArticle) and no terminal verdict (uncollected-strand.js hasTerminalVerdict:
 * not a review, or a duplicate pointer to a canonical sibling), and its text is missing, truncated or an excerpt/stub
 * while nothing marks it complete. The collector still makes the final per-file call (holds, paywall rechecks); this
 * only decides whether the step runs.
 *
 *   node scripts/lib/poller-needs-collection.js <showId> [--dir=data/review-texts]   -> prints the count
 */
const fs = require('fs');
const path = require('path');
const { hasTerminalVerdict } = require('./uncollected-strand');

const FULL_TEXT_MIN = 1500; // collect-review-texts.js treats a longer stored text as already collected
const PARTIAL_TIERS = new Set(['truncated', 'needs-rescrape', 'excerpt', 'stub']);

/** One parsed review file. Pure. */
function reviewNeedsCollection(review, siblings) {
  if (!review || typeof review !== 'object') return false;
  if (!/^https?:\/\//i.test(String(review.url || ''))) return false;
  if (review.wrongProduction || review.wrongShow || review.isRoundupArticle) return false;
  if (hasTerminalVerdict(review, siblings)) return false;
  if (review.textQuality === 'truncated' || review.textStatus === 'truncated' || PARTIAL_TIERS.has(review.contentTier)) return true;
  if (review.contentTier === 'complete' || review.textQuality === 'full' || review.isFullReview === true) return false;
  const len = typeof review.fullText === 'string' ? review.fullText.trim().length : 0;
  return len < FULL_TEXT_MIN;
}

/** Every review file in one show folder that needs collection. Unreadable folder = none. */
function showNeedsCollection(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const siblings = new Map();
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('_')) continue;
    try { siblings.set(n, JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch (_) { /* unreadable file: the collector's problem */ }
  }
  return [...siblings].filter(([, r]) => reviewNeedsCollection(r, siblings)).map(([n]) => n);
}

module.exports = { reviewNeedsCollection, showNeedsCollection, FULL_TEXT_MIN };

if (require.main === module) {
  const showId = process.argv[2] || '';
  const dirArg = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice(6) || path.join('data', 'review-texts');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(showId)) { console.error('usage: poller-needs-collection.js <showId> [--dir=]'); process.exit(2); }
  const files = showNeedsCollection(path.join(dirArg, showId));
  for (const f of files.slice(0, 20)) console.error(`  needs collection: ${f}`);
  console.log(files.length);
}
