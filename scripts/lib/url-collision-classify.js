'use strict';

/**
 * Pure classification for the BRO-62 multi-critic URL-collision audit.
 *
 * A "collision group" is every review-text file under one show directory that
 * shares the same (outletId, url) key — i.e. 2+ critics filed under the same
 * outlet pointing at the exact same article URL. Most of these are legitimate:
 * one roundup page (BroadwayWorld Reviews Roundup, DTLI, Show Score, …) covers
 * many critics, or a file is explicitly flagged as a combined/roundup article.
 * A smaller subset is the NYSR-type contamination this audit exists to find:
 * critic B's file was scraped/written with critic A's actual review content,
 * so the two files are byte-identical under different criticName values.
 *
 * See scripts/audit-url-collisions.js for the filesystem walk that builds
 * groups and calls classifyCollisionGroup(); this module has no fs/process
 * access so its decisions are unit-testable against synthetic fixtures.
 */

const { AGGREGATOR_OUTLET_IDS } = require('./aggregator-domains');

const UNKNOWN_CRITIC_RE = /^unknown$/i;
const MIN_COMPARABLE_LENGTH = 50;

function normalizeFullTextForCompare(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isUnknownCritic(name) {
  return !name || UNKNOWN_CRITIC_RE.test(String(name).trim());
}

function isSafeAggregatorOutlet(outletId) {
  return !!outletId && AGGREGATOR_OUTLET_IDS.has(outletId);
}

// isRoundupArticle / isCombinedReview mark a file as legitimately covering
// multiple critics or multiple shows under one URL — either is sufficient to
// clear the whole group, since it's the same underlying "one article, many
// bylines" shape this audit needs to exempt.
function isSafeFlaggedFile(data) {
  return !!(data && (data.isRoundupArticle === true || data.isCombinedReview === true));
}

// A file already carrying an exclusion verdict (wrong show/production, or a
// live duplicate pointer) is not an active collision — some prior pass (this
// audit's own --apply, or an unrelated guard) already resolved it.
function isAlreadyExcluded(data) {
  return !!(
    data &&
    (data.wrongShow === true || data.wrongProduction === true || data.duplicateOf || data.duplicateTextOf)
  );
}

/**
 * Classify one same-show/same-outlet/same-URL collision group.
 *
 * @param {string} outletId - the outlet these files were filed under
 * @param {Array<{file: string, data: object}>} entries - 2+ review-text records
 *   sharing the (outletId, url) key
 * @returns {{
 *   category: 'not-a-collision'|'safe-aggregator'|'safe-flagged'|'already-excluded'
 *     |'needs-review'|'contamination-fixable'|'contamination-needs-review',
 *   reason: string,
 *   canonical?: string,
 *   contaminated?: string[],
 *   files?: string[],
 * }}
 */
function classifyCollisionGroup(outletId, entries) {
  if (!entries || entries.length < 2) {
    return { category: 'not-a-collision', reason: 'fewer than 2 files share this key' };
  }

  // 1. Known multi-critic aggregator outlet (BWW roundup, DTLI, Show Score,
  //    Playbill Verdict, WET, Stagedoor, LBO, NYC Theatre, theatre.reviews) —
  //    one URL legitimately fanning out to many critic files is the expected
  //    shape there.
  if (isSafeAggregatorOutlet(outletId)) {
    return { category: 'safe-aggregator', reason: `outlet '${outletId}' is a known multi-critic aggregator` };
  }

  // 2. A real (non-aggregator) outlet page explicitly marked as covering
  //    multiple critics/shows.
  if (entries.some((e) => isSafeFlaggedFile(e.data))) {
    return { category: 'safe-flagged', reason: 'file(s) carry isRoundupArticle/isCombinedReview' };
  }

  // 3. Already resolved: at most one file in the group is still "live".
  const unexcluded = entries.filter((e) => !isAlreadyExcluded(e.data));
  if (unexcluded.length <= 1) {
    return { category: 'already-excluded', reason: 'all but one file already carries an exclusion/duplicate flag' };
  }

  const comparable = unexcluded.filter(
    (e) => normalizeFullTextForCompare(e.data && e.data.fullText).length >= MIN_COMPARABLE_LENGTH
  );
  if (comparable.length < 2) {
    return { category: 'needs-review', reason: 'fewer than 2 files have enough content to compare' };
  }

  const first = normalizeFullTextForCompare(comparable[0].data.fullText);
  const allIdentical = comparable.every((e) => normalizeFullTextForCompare(e.data.fullText) === first);

  if (!allIdentical) {
    // Different critics, different text, same nominal URL — most likely a
    // real outlet that published more than one piece under a shared/canonical
    // URL, or a URL that isn't actually the same article. Genuinely ambiguous
    // without content-source verification; not this audit's job to guess.
    return {
      category: 'needs-review',
      reason: 'distinct content per critic sharing the URL — not a text-fingerprint duplicate',
      files: comparable.map((e) => e.file),
    };
  }

  // Identical text across 2+ distinct-critic files at a non-aggregator outlet
  // — the NYSR-type contamination shape.
  const named = comparable.filter((e) => !isUnknownCritic(e.data.criticName));
  const unknown = comparable.filter((e) => isUnknownCritic(e.data.criticName));

  if (named.length === 1 && unknown.length >= 1) {
    // The unambiguous, safe-to-auto-fix slice: one file has a real critic
    // name, the rest are unresolved "Unknown" placeholders carrying a byte-
    // identical copy of that same text. Point the placeholders at the named
    // file via duplicateTextOf — the existing content-fingerprint dedup
    // pointer (scripts/lib/aggregator-url-latent.js) — rather than deleting
    // anything.
    return {
      category: 'contamination-fixable',
      reason: 'identical text; one file has a resolved critic name, the rest are Unknown placeholders',
      canonical: named[0].file,
      contaminated: unknown.map((e) => e.file),
    };
  }

  // Two or more DIFFERENTLY-named critics with byte-identical text. This is
  // real contamination, but nothing here proves which critic actually wrote
  // it (co-bylines exist; scraper mix-ups exist) — surface for manual review
  // rather than guessing.
  return {
    category: 'contamination-needs-review',
    reason: `identical text across ${named.length} distinctly-named critics — cannot auto-resolve which is correct`,
    files: comparable.map((e) => e.file),
  };
}

module.exports = {
  normalizeFullTextForCompare,
  isUnknownCritic,
  isSafeAggregatorOutlet,
  isSafeFlaggedFile,
  isAlreadyExcluded,
  classifyCollisionGroup,
};
