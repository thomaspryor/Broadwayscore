/**
 * Aggregator-URL contamination: the two holes that let it into the corpus.
 *
 * INCIDENT (2026-08-09). audit-show-review-gap.js met a theatre.reviews roundup
 * URL for a show it was auditing. theatre.reviews is a known aggregator, but:
 *
 *   1. provisionalOutletIdFromHost("theatre.reviews") happily minted the slug
 *      "theatre" (registrable label of a two-part host), so the audit believed
 *      it had found an unknown OUTLET rather than a roundup, and
 *   2. createOrMergeReviewFile — the shared writer behind ~20 callers — had no
 *      aggregator-URL guard, so the write landed.
 *
 * The result is a review-text file whose url is on an aggregator domain while
 * its outletId is not an aggregator: the zero-tolerance `aggregator_url_mismatch`
 * error in validate-review-texts.js. Five such files accumulated; the newest held
 * the trunk red (Test Suite, 27 failures over 3 days).
 *
 * The guard predicate (shouldSkipAggregatorUrlWrite) already existed — it just
 * lived inside gather-reviews.js, one writer out of many. These tests pin BOTH
 * the root-cause fix and the chokepoint fix, and equally pin what must still be
 * allowed through, because a guard that over-blocks would drop legitimate
 * aggregator star-stubs (the 2026-06-21 regression).
 *
 * Run: node --test scripts/lib/aggregator-url-write-chokepoint.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { AGGREGATOR_DOMAINS } = require('./aggregator-domains.js');

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

// ---------------------------------------------------------------- root cause

test('provisionalOutletIdFromHost mints nothing for ANY known aggregator domain', () => {
  assert.ok(AGGREGATOR_DOMAINS.size > 0, 'guard would be vacuous with an empty domain set');
  for (const host of AGGREGATOR_DOMAINS) {
    assert.equal(provisionalOutletIdFromHost(host), null, `${host} must not mint an outlet id`);
    assert.equal(provisionalOutletIdFromHost(`www.${host}`), null, `www.${host} must not mint an outlet id`);
  }
});

test('provisionalOutletIdFromHost: theatre.reviews specifically (the incident host)', () => {
  // Before the fix this returned "theatre" — a generic word masquerading as an
  // outlet, which is what made the contamination look plausible downstream.
  assert.equal(provisionalOutletIdFromHost('theatre.reviews'), null);
});

test('provisionalOutletIdFromHost still onboards real unknown publications', () => {
  // Regression fence: over-blocking here would silently lose the ctvoice /
  // New York Notebook class the provisional path exists to capture.
  const expected = {
    'ctvoice.com': 'ctvoice',
    '1minutecritic.com': '1minutecritic',
    'birminghamstage.com': 'birminghamstage',
    'londontheatre.co.uk': 'londontheatre',
    'newyorknotebook.substack.com': 'newyorknotebook',
    'pagesonstages.wordpress.com': 'pagesonstages',
  };
  for (const [host, slug] of Object.entries(expected)) {
    assert.equal(provisionalOutletIdFromHost(host), slug, `${host} must still resolve`);
  }
});

// ----------------------------------------------------------------- chokepoint

const write = (input) => quiet(() => createOrMergeReviewFile(
  'grace-pervades-west-end-2026',
  { criticName: 'Paul Lewis', fields: {}, ...input },
  { dryRun: true },
));

test('createOrMergeReviewFile refuses a real outlet carrying an aggregator roundup URL', () => {
  // The exact shape of the five contaminated files.
  const r = write({
    outletId: 'theatre',
    outlet: 'theatre',
    url: 'https://theatre.reviews/reviews-roundup/im-every-woman-troubadour-reviews/',
    source: 'submit-review-form',
    fields: { fullText: 'Theatre reviews roundup: with one exception the main outlets were lukewarm…' },
  });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'aggregator-url-mismatch');
});

test('the refusal is not specific to one domain or one source', () => {
  for (const [url, source] of [
    ['https://www.show-score.com/off-broadway-shows/some-show', 'serp-discovery'],
    ['https://stagedoor.com/shows/some-show', 'manual'],
    ['https://theatre.reviews/reviews-roundup/some-show-reviews/', 'audit-gap-ingest'],
  ]) {
    const r = write({ outletId: 'guardian', outlet: 'Guardian', url, source, fields: { fullText: 'x'.repeat(400) } });
    assert.equal(r.reason, 'aggregator-url-mismatch', `${url} via ${source} must be refused`);
  }
});

test('an aggregator domain the registry maps to its own outlet is rerouted, not refused', () => {
  // didtheylikeit.com resolves to the "dtli" outlet, so the URL refinement that
  // runs before this guard rewrites outletId guardian → dtli. The file is then a
  // legitimate aggregator record, not contamination. The invariant either way:
  // a review must never end up filed under a REAL outlet with an aggregator URL.
  const r = write({
    outletId: 'guardian',
    outlet: 'Guardian',
    url: 'https://didtheylikeit.com/reviews/some-show',
    source: 'submit-review-form',
    fields: { fullText: 'x'.repeat(400) },
  });
  // Behaviour narrowed 2026-08-09 (code review on 2c679ad4bb1): the reroute-to-dtli
  // branch was itself the laundering — it filed a Guardian review as DTLI's own.
  // Now the write is refused outright. Either refusal reason satisfies the
  // invariant; what must never happen is a file landing under `guardian` with a
  // didtheylikeit.com URL, which is the zero-tolerance validator error.
  assert.equal(r.action, 'skipped', `expected a refusal, got ${JSON.stringify(r)}`);
  assert.ok(
    r.reason === 'aggregator-url-mismatch' || r.reason === 'aggregator-url-refinement-refused',
    `expected an aggregator refusal reason, got ${JSON.stringify(r)}`,
  );
  assert.ok(!/\/guardian--/.test(r.filepath || ''), 'must not file under the real outlet');
});

test('aggregator-SOURCE writes still land — they legitimately carry the roundup URL', () => {
  const r = write({
    outletId: 'guardian',
    outlet: 'Guardian',
    url: 'https://theatre.reviews/reviews-roundup/some-show-reviews/',
    source: 'theatre-reviews',
    fields: { fullText: 'x'.repeat(400) },
  });
  assert.notEqual(r.reason, 'aggregator-url-mismatch');
});

test('a star-stub carrying a real score still lands (2026-06-21 regression fence)', () => {
  // Blocking these would drop legitimate aggregator star-stubs — the reason
  // shouldSkipAggregatorUrlWrite is value-first rather than domain-first.
  const stars = write({
    outletId: 'west-end-wilma',
    outlet: 'West End Wilma',
    url: 'https://westendtheatre.co.uk/some-roundup/',
    source: 'serp-discovery',
    fields: { aggregatorStars: '5/5' },
  });
  assert.notEqual(stars.reason, 'aggregator-url-mismatch');

  const score = write({
    outletId: 'standard',
    outlet: 'Evening Standard',
    url: 'https://stagedoor.com/shows/some-show',
    source: 'serp-discovery',
    fields: { originalScore: '3/5 stars' },
  });
  assert.notEqual(score.reason, 'aggregator-url-mismatch');
});

test('ordinary outlet-domain writes are untouched', () => {
  const r = write({
    outletId: 'guardian',
    outlet: 'Guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/aug/01/some-review',
    source: 'serp-discovery',
    fields: { fullText: 'x'.repeat(400) },
  });
  assert.notEqual(r.reason, 'aggregator-url-mismatch');
  assert.equal(r.action, 'new');
});
