/**
 * URL-based outlet refinement must never rewrite a real outlet's id ONTO an
 * aggregator outlet.
 *
 * THE CLASS: an aggregator domain hosts ROUNDUP pages citing many outlets. The
 * cross-domain refinement in review-file-writer.js treats "the URL's domain
 * resolves to outlet X" as ground truth — correct for theguardian.com, wrong for
 * westendtheatre.com, whose pages cite a dozen outlets at once. Left unguarded it
 * rewrote outletId to the aggregator's, which BOTH destroyed the real outlet's
 * attribution AND laundered the file past shouldSkipAggregatorUrlWrite(), since
 * that guard deliberately permits an aggregator URL when outletId IS the
 * aggregator.
 *
 * Measured 2026-08-09 across 42,251 review-text files: 395 carry a URL on one of
 * the four aggregator domains that resolve to a registry outlet, 66 of them under
 * a REAL outlet id (guardian, timeout, telegraph, financialtimes, daily-mail, …).
 * Those 66 are the ones refinement would have collapsed into `westendtheatre`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldRefuseAggregatorOutletRefinement,
  AGGREGATOR_OUTLET_IDS,
} = require('./aggregator-domains.js');
const { resolveOutletFromUrl, normalizeOutlet } = require('./review-normalization.js');

test('refuses to refine a real outlet onto an aggregator outlet', () => {
  // The exact shape measured in the corpus: a Guardian star-stub carrying a WET
  // roundup URL. Refinement would have made this file `westendtheatre`.
  assert.equal(shouldRefuseAggregatorOutletRefinement('westendtheatre', 'guardian'), true);
  assert.equal(shouldRefuseAggregatorOutletRefinement('dtli', 'guardian'), true);
  assert.equal(shouldRefuseAggregatorOutletRefinement('london-box-office', 'telegraph'), true);
  assert.equal(shouldRefuseAggregatorOutletRefinement('show-score', 'nytimes'), true);
});

test('every real outlet seen on a laundering domain in the corpus is protected', () => {
  // Verbatim from the 2026-08-09 corpus scan of westendtheatre.com URLs.
  const realOutletsSeen = [
    'guardian', 'timeout', 'telegraph', 'financialtimes', 'daily-mail',
    'express-uk', 'standard', 'independent', 'times-uk', 'i-paper',
    'london-theatre', 'thestage', 'metro-uk', 'michael-billington',
    'reviewing-the-drama', 'nottingham-confidential',
  ];
  for (const outlet of realOutletsSeen) {
    assert.equal(
      shouldRefuseAggregatorOutletRefinement('westendtheatre', outlet), true,
      `${outlet} would have been collapsed into westendtheatre`,
    );
  }
});

test('does NOT interfere with genuine aggregator records', () => {
  // outletId already IS the aggregator — nothing to protect, and refusing here
  // could block a legitimate alias fix (lbo → london-box-office).
  assert.equal(shouldRefuseAggregatorOutletRefinement('westendtheatre', 'westendtheatre'), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('dtli', 'dtli'), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('london-box-office', 'lbo'), false);
});

test('does NOT touch ordinary cross-domain refinement', () => {
  // The case the refinement exists for: DTLI credited a theguardian.com URL to
  // "Observer". Neither side is an aggregator, so the URL still wins.
  assert.equal(shouldRefuseAggregatorOutletRefinement('guardian', 'observer'), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('timeout-london', 'timeout'), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('nytimes', 'nypost'), false);
});

test('returns false rather than throwing on missing input', () => {
  assert.equal(shouldRefuseAggregatorOutletRefinement(undefined, 'guardian'), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('westendtheatre', undefined), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement(null, null), false);
  assert.equal(shouldRefuseAggregatorOutletRefinement('', ''), false);
});

test('normalizes the current outlet before deciding (aliased aggregator ids)', () => {
  // A caller may pass a raw/capitalized id. Without normalization a genuine
  // aggregator record would look like a real outlet and get "protected" from a
  // refinement it actually wants.
  assert.equal(shouldRefuseAggregatorOutletRefinement('show-score', 'Show-Score'), false);
});

test('the four laundering domains still resolve to aggregator outlets (guard is live)', () => {
  // If the registry stops resolving these, this guard silently becomes a no-op —
  // the vacuous-gate class. Pin the wiring, not just the predicate.
  const laundering = {
    'https://didtheylikeit.com/reviews/x': 'dtli',
    'https://www.westendtheatre.com/x': 'westendtheatre',
    'https://theatrereviews.wordpress.com/x': 'theatre-reviews-limited',
    'https://www.londonboxoffice.co.uk/news/x': 'london-box-office',
  };
  for (const [url, expected] of Object.entries(laundering)) {
    const resolved = resolveOutletFromUrl(url);
    assert.ok(resolved, `${url} no longer resolves to any outlet`);
    assert.equal(resolved.outletId, expected, `${url} resolution changed`);
    assert.ok(
      AGGREGATOR_OUTLET_IDS.has(normalizeOutlet(expected) || expected),
      `${expected} dropped out of AGGREGATOR_OUTLET_IDS — refinement would launder again`,
    );
  }
});

test('a genuine theatre.reviews record is not treated as contamination', () => {
  // Regression: AGGREGATOR_OUTLET_IDS listed only the dead spelling
  // 'theatre-reviews'. The registry id is 'theatre-reviews-limited', so a LEGIT
  // TR aggregator record looked like a real outlet sitting on an aggregator
  // domain — the write guard refused it and the validator would error on it.
  const { isAggregatorUrlMismatch, shouldSkipAggregatorUrlWrite } = require('./aggregator-domains.js');
  const url = 'https://theatrereviews.wordpress.com/2026/01/01/some-show/';
  assert.equal(isAggregatorUrlMismatch(url, 'theatre-reviews-limited'), false);
  assert.equal(
    shouldSkipAggregatorUrlWrite({ source: 'serp-discovery', url }, 'theatre-reviews-limited'),
    false,
  );
  // The contamination class it must still catch on that same domain.
  assert.equal(isAggregatorUrlMismatch(url, 'guardian'), true);
});

test('westendtheatre.com is covered even though AGGREGATOR_DOMAINS carries .co.uk', () => {
  // The reason this guard keys on the resolved OUTLET rather than the domain set.
  const { AGGREGATOR_DOMAINS } = require('./aggregator-domains.js');
  assert.equal(AGGREGATOR_DOMAINS.has('westendtheatre.com'), false,
    'if .com was added to the domain set, revisit the validator carve-out first');
  const resolved = resolveOutletFromUrl('https://www.westendtheatre.com/reviews/x');
  assert.equal(shouldRefuseAggregatorOutletRefinement(resolved.outletId, 'guardian'), true);
});
