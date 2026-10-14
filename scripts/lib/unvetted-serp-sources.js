'use strict';

/**
 * Canonical set of `source` tags written by raw, unvetted SERP/web-search
 * discovery paths — as opposed to aggregator-sourced writes (show-score,
 * bww-*, dtli, playbill-verdict, theatre-record, ...) or human-submitted
 * writes (submit-review-form, manual-entry, manual-serp), which carry some
 * form of vetting before the URL/content reaches review-texts.
 *
 * Originally hand-maintained only inside audit-corpus-contamination.js (its
 * own header documents the per-source mapping: gather-reviews.js's SERP/
 * site-search discovery — serp-discovery, serp-discovery-per-critic,
 * site-search — discover-opening-night-reviews.js — broad-web-serp,
 * opening-night-discovery — discover-outlet-reviews-serp.js —
 * outlet-serp-discovery — and opening-night-poller.js — serp-discovery).
 * Extracted to scripts/lib/ (BRO-4101) so a second consumer — review-guards.js's
 * namedNonReviewUrl exclusion rule, gating a NAMED_NON_REVIEW_URL_PATTERNS
 * match to unvetted-SERP writes only — doesn't hand-roll a narrower/different
 * copy (an earlier draft of that fix used a bare `source.startsWith('serp-
 * discovery')` check, which missed outlet-serp-discovery/broad-web-serp/
 * site-search entirely). scripts/sweep-named-non-review-urls.js's --apply
 * scope reuses the same set for the identical reason.
 */
const SUSPECT_SOURCES = new Set([
  'serp-discovery',
  'serp-discovery-per-critic',
  'site-search',
  'broad-web-serp',
  'outlet-serp-discovery',
  'opening-night-discovery',
]);

function isUnvettedSerpSource(source) {
  return typeof source === 'string' && SUSPECT_SOURCES.has(source);
}

module.exports = { SUSPECT_SOURCES, isUnvettedSerpSource };
