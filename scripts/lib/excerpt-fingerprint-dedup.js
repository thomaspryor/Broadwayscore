'use strict';

/**
 * Same-outlet dedup for aggregator-excerpt-only records (BRO-6628 item 4).
 *
 * A no-url, excerpt-only BWW roundup record survived rebuild and double-counted on
 * A Few Good Men (BRO-6585): independent--bcaitlin-hornik and independent--caitlin-hornik
 * carried the SAME `bwwExcerpt` under a mangled byline. The existing content-fingerprint
 * dedup in rebuild-all-reviews.js only looks at `fullText`, and URL dedup needs a url, so
 * a record with neither slipped through both.
 *
 * Two records at the same outlet whose aggregator excerpt is the same text are the same
 * review, whatever the byline says, so the first-seen (files are pre-sorted by quality)
 * wins and the rest drop. Only records WITHOUT usable fullText are keyed here; the
 * fullText fingerprint already covers the others.
 *
 * Pure apart from the `seen` map the caller owns.
 */

const { computeContentFingerprint } = require('./content-quality');

// One list of aggregator excerpt fields for the whole codebase (includes the West End ones).
const { EXCERPT_FIELDS: AGGREGATOR_EXCERPT_FIELDS } = require('./excerpt-fields');

const MIN_FULLTEXT_CHARS = 100; // same bar as the fullText fingerprint dedup

/** True when the record's own text is long enough for the fullText fingerprint dedup to key it. */
function hasUsableFullText(data) {
  return !!(data && data.fullText && data.fullText.length >= MIN_FULLTEXT_CHARS);
}

/**
 * Dedup keys (one per excerpt field present) for an excerpt-only record, or [] when
 * the record has usable fullText or no excerpt long enough to fingerprint
 * (computeContentFingerprint ignores text under 50 normalized chars, so generic
 * one-liners can never collide).
 */
function excerptFingerprintKeys(data, outletKey) {
  if (!data || hasUsableFullText(data)) return [];
  const keys = [];
  for (const field of AGGREGATOR_EXCERPT_FIELDS) {
    const text = data[field];
    if (typeof text !== 'string') continue;
    const fp = computeContentFingerprint(text);
    if (fp) keys.push(`${outletKey}|${field}|${fp}`);
  }
  return keys;
}

/**
 * Check a record against the claims seen so far and claim its keys when it is new.
 * Returns { duplicateOf: <winner's file> } when it repeats an earlier record's excerpt
 * (and claims nothing), else { duplicateOf: null } after claiming. `claim(map, key, value)`
 * is injectable so rebuild-all-reviews.js can route claims through its dedup ledger,
 * which releases them if the winner is dropped later (BRO-5901).
 */
function checkExcerptDuplicate(data, outletKey, file, seen, claim = (m, k, v) => m.set(k, v)) {
  const keys = excerptFingerprintKeys(data, outletKey);
  for (const key of keys) {
    if (seen.has(key)) return { duplicateOf: seen.get(key).file, key };
  }
  for (const key of keys) claim(seen, key, { file });
  return { duplicateOf: null };
}

module.exports = { AGGREGATOR_EXCERPT_FIELDS, hasUsableFullText, excerptFingerprintKeys, checkExcerptDuplicate };
