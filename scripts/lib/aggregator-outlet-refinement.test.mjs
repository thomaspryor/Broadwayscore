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
  // Deliberately does NOT assert what AGGREGATOR_DOMAINS contains: pinning
  // `.has('westendtheatre.com') === false` would turn CI red on the correct
  // future fix for the TLD gap (card "P1: aggregator guard misses
  // westendtheatre.com"). Outlet-keying is what makes this guard survive that
  // change either way, so that is what the test asserts.
  const resolved = resolveOutletFromUrl('https://www.westendtheatre.com/reviews/x');
  assert.equal(shouldRefuseAggregatorOutletRefinement(resolved.outletId, 'guardian'), true);
});

test('normalizes the URL-resolved outlet too, not just the current one', () => {
  // Asymmetric normalization would let a capitalized/aliased first argument slip
  // past and permit the laundering this guard exists to stop.
  assert.equal(shouldRefuseAggregatorOutletRefinement('Show-Score', 'guardian'), true);
  assert.equal(shouldRefuseAggregatorOutletRefinement('DTLI', 'guardian'), true);
});

// ------------------------------------------------------- write-chokepoint relax
// Task #1194 (closed 2026-08-12) gave the validator a carve-out for a real-outlet
// file that carries a score sourced FROM the roundup (aggregatorStars/originalScore)
// — see hasAggregatorUrlMismatch() in aggregator-url-latent.js. Before this, the
// write-time refusal above dropped that case outright: a scored star-stub landing
// on an aggregator roundup URL never even reached the corpus, because the
// validator would have flagged it as aggregator_url_mismatch. Now that the
// validator carve-out exists, createOrMergeReviewFile can let the scored case land
// under its TRUE (name-derived) outlet instead of dropping it — unscored writes
// stay refused, since those are the real contamination class (nothing worth
// preserving under the wrong outlet).
test('createOrMergeReviewFile: a scored star-stub keeps its true outlet instead of being dropped', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const quiet = (fn) => {
    const w = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  // from-the-fourth-row carries no registered domain in outlet-registry.json, so
  // this exercises the write chokepoint end-to-end (past validateUrlDomain too),
  // not just the refinement predicate.
  const scored = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'from-the-fourth-row',
    outlet: 'From the Fourth Row',
    criticName: 'Pat Reviewer',
    url: 'https://westendtheatre.co.uk/some-roundup/',
    source: 'serp-discovery',
    fields: { aggregatorStars: '5/5' },
  }, { dryRun: true }));
  assert.equal(scored.action, 'new', `expected the scored star-stub to land, got ${JSON.stringify(scored)}`);
  assert.match(scored.filepath, /from-the-fourth-row/, 'must file under the TRUE outlet, not the aggregator');
  assert.ok(!/westendtheatre/.test(scored.filepath), 'must never file under the aggregator outlet');

  const scoredViaOriginalScore = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'from-the-fourth-row',
    outlet: 'From the Fourth Row',
    criticName: 'Pat Reviewer',
    url: 'https://www.stagedoor.com/shows/some-show',
    source: 'serp-discovery',
    fields: { originalScore: '4/5' },
  }, { dryRun: true }));
  assert.equal(scoredViaOriginalScore.action, 'new',
    `originalScore must also count as a preservable score, got ${JSON.stringify(scoredViaOriginalScore)}`);
});

test('createOrMergeReviewFile: a scored stub for a DOMAIN-REGISTERED outlet also lands (not just domainless ones)', () => {
  // Regression fence: an earlier version of this fix only unblocked the early
  // refusal but left the downstream "Guard: domain validation" check (which
  // compares outletId's REGISTERED domain against the URL host) re-refusing the
  // exact same write for any outlet that HAS a registered domain — i.e. most of
  // the real corpus target population (guardian→theguardian.com,
  // telegraph→telegraph.co.uk, etc. all mismatch westendtheatre.com by design).
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const quiet = (fn) => {
    const w = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  const scored = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'guardian',
    outlet: 'The Guardian',
    criticName: 'Kate Wyver',
    url: 'https://www.westendtheatre.com/295880/news/reviews/some-review/',
    source: 'westendtheatre',
    fields: { aggregatorStars: '4/5 stars' },
  }, { dryRun: true }));
  assert.equal(scored.action, 'new', `expected the scored star-stub to land, got ${JSON.stringify(scored)}`);
  assert.match(scored.filepath, /\/guardian--/, 'must file under the TRUE (domain-registered) outlet');
});

test('createOrMergeReviewFile: an unscored write on an aggregator URL is still refused', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const quiet = (fn) => {
    const w = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  const unscored = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'from-the-fourth-row',
    outlet: 'From the Fourth Row',
    criticName: 'Pat Reviewer',
    url: 'https://westendtheatre.co.uk/some-roundup/',
    source: 'serp-discovery',
    fields: { fullText: 'x'.repeat(400) },
  }, { dryRun: true }));
  assert.equal(unscored.action, 'skipped');
  assert.equal(unscored.reason, 'aggregator-url-refinement-refused');
});

test('the refusal is classified as a CONFLICT skip, not an expected rejection', () => {
  // The writer returns {action:'skipped', reason:'aggregator-url-refinement-refused'}.
  // Every skip reason review-file-writer.js emits must be classified — an
  // unclassified reason is what reddened main on 2026-08-09 (commit c67cc1b2777).
  const { classifyIngestSkip, describeSkip } = require('./ingest-skip-classify.js');
  // classifyIngestSkip parses real writer stdout, so feed it that shape.
  const classified = classifyIngestSkip('Skipped: aggregator-url-refinement-refused');
  assert.equal(classified.kind, 'conflict');
  assert.equal(classified.reason, 'aggregator-url-refinement-refused');
  const msg = describeSkip('hamilton-2015', 'https://didtheylikeit.com/reviews/x', {
    reason: 'aggregator-url-refinement-refused',
    detail: null,
  });
  assert.match(msg, /roundup domain/i);
  assert.ok(!/skipped as aggregator-url-refinement-refused/.test(msg),
    'must have a bespoke message, not the generic fallback');
});

// ------------------------------------------------------- source-aware exemption
// The refusal above only ever looked at the resolved outlet, never at
// input.source — unlike shouldSkipAggregatorUrlWrite() (aggregator-domains.js),
// which checks isAggregatorReviewSource(source) FIRST and exempts any
// aggregator-sourced write before it ever looks at score. A genuine
// aggregator-source citation of a real outlet's article (source='westendtheatre',
// outletId='guardian', URL on westendtheatre.com, no extractable score) was
// refused here before it ever reached that source-aware guard (task #1335,
// found during #1325's /ship-check).
test('createOrMergeReviewFile: an aggregator-SOURCE write on an aggregator URL is not refused, even without a score', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const quiet = (fn) => {
    const w = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  // from-the-fourth-row carries no registered domain in outlet-registry.json, so
  // this exercises the write chokepoint end-to-end without also tripping the
  // separate domain-validation guard further down (a domain-registered outlet
  // like 'guardian' would fail there for an unrelated reason, muddying what
  // this test is meant to pin).
  const result = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'from-the-fourth-row',
    outlet: 'From the Fourth Row',
    criticName: 'Pat Reviewer',
    url: 'https://westendtheatre.co.uk/some-roundup/',
    source: 'westendtheatre',
    fields: { fullText: 'x'.repeat(400) },
  }, { dryRun: true }));
  assert.notEqual(result.reason, 'aggregator-url-refinement-refused',
    `aggregator-sourced write must not hit this refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.action, 'new', `expected the aggregator-source write to land, got ${JSON.stringify(result)}`);
  assert.match(result.filepath, /from-the-fourth-row/, 'must file under the TRUE outlet, not the aggregator');
});

test('createOrMergeReviewFile: a non-aggregator-source write on an aggregator URL is still refused (regression fence)', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const quiet = (fn) => {
    const w = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  const result = quiet(() => createOrMergeReviewFile('grace-pervades-west-end-2026', {
    outletId: 'from-the-fourth-row',
    outlet: 'From the Fourth Row',
    criticName: 'Pat Reviewer',
    url: 'https://westendtheatre.co.uk/some-roundup/',
    source: 'serp-discovery',
    fields: { fullText: 'x'.repeat(400) },
  }, { dryRun: true }));
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'aggregator-url-refinement-refused');
});
