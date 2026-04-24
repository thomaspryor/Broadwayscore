/**
 * Unit tests for canonicalizeUrlForDedup (scripts/lib/review-guards.js).
 *
 * Root incident: Rocky Horror 2026-04-23. Cote Notices shipped with two
 * distinct critic attributions for the same Substack article because the
 * URLs differed only by ?triedRedirect=true. rebuild-all-reviews.js kept
 * query params verbatim, so the dedup key diverged and both files survived.
 *
 * This helper is consumed by rebuild-all-reviews, gather-reviews (via
 * llm-extractor), multi-critic-serp, and llm-extractor merge logic. Changing
 * its behavior shifts dedup across the whole pipeline — keep the test matrix
 * strict.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  canonicalizeUrlForDedup,
  TRACKING_PARAM_NAMES,
  TRACKING_PARAM_PREFIXES,
} = require('../../scripts/lib/review-guards.js');

describe('canonicalizeUrlForDedup — tracking-param stripping', () => {
  test('strips ?triedRedirect=true (Cote Notices / Rocky Horror 2026-04-23 repro)', () => {
    const clean = 'https://cotenotices.substack.com/p/rocky-horror-show';
    const dirty = 'https://cotenotices.substack.com/p/rocky-horror-show?triedRedirect=true';
    assert.strictEqual(canonicalizeUrlForDedup(clean), canonicalizeUrlForDedup(dirty),
      'URLs that differ only by ?triedRedirect must collapse to the same dedup key');
  });

  test('strips utm_* params', () => {
    const a = 'https://nytimes.com/theater/review';
    const b = 'https://nytimes.com/theater/review?utm_source=twitter&utm_campaign=launch';
    assert.strictEqual(canonicalizeUrlForDedup(a), canonicalizeUrlForDedup(b));
  });

  test('strips fbclid + gclid + mc_eid + _bhlid', () => {
    const a = 'https://example.com/article';
    const b = 'https://example.com/article?fbclid=abc&gclid=xyz&mc_eid=123&_bhlid=456';
    assert.strictEqual(canonicalizeUrlForDedup(a), canonicalizeUrlForDedup(b));
  });

  test('preserves non-tracking query params (article ID case)', () => {
    // Some legacy CMS sites use ?p= or ?article_id= as the canonical article ID.
    const a = canonicalizeUrlForDedup('https://example.com/?p=1234');
    const b = canonicalizeUrlForDedup('https://example.com/?p=5678');
    assert.notStrictEqual(a, b,
      'URLs with DIFFERENT non-tracking params must NOT collapse — could silently merge two different reviews');
    assert.ok(a.includes('p=1234'));
    assert.ok(b.includes('p=5678'));
  });

  test('preserves ?page= even though ref/src are stripped', () => {
    const a = canonicalizeUrlForDedup('https://example.com/roundup?page=2');
    const b = canonicalizeUrlForDedup('https://example.com/roundup?page=3');
    assert.notStrictEqual(a, b, 'different pages are distinct articles');
  });

  test('mixed tracking + article ID: strips tracking, keeps article ID', () => {
    const out = canonicalizeUrlForDedup(
      'https://example.com/?article_id=9&utm_source=x&fbclid=y'
    );
    assert.ok(out.includes('article_id=9'), 'article_id preserved');
    assert.ok(!out.includes('utm_source'), 'utm_source stripped');
    assert.ok(!out.includes('fbclid'), 'fbclid stripped');
  });
});

describe('canonicalizeUrlForDedup — case + trailing slash + fragment', () => {
  test('lowercases hostname', () => {
    const a = canonicalizeUrlForDedup('https://NYTimes.Com/review');
    const b = canonicalizeUrlForDedup('https://nytimes.com/review');
    assert.strictEqual(a, b);
  });

  test('strips trailing slash', () => {
    const a = canonicalizeUrlForDedup('https://example.com/review/');
    const b = canonicalizeUrlForDedup('https://example.com/review');
    assert.strictEqual(a, b);
  });

  test('strips fragment', () => {
    const a = canonicalizeUrlForDedup('https://example.com/review#comments');
    const b = canonicalizeUrlForDedup('https://example.com/review');
    assert.strictEqual(a, b);
  });

  test('strips both utm_* and fragment together', () => {
    const dirty = 'https://example.com/review?utm_source=fb#section-2';
    const clean = 'https://example.com/review';
    assert.strictEqual(canonicalizeUrlForDedup(dirty), canonicalizeUrlForDedup(clean));
  });
});

describe('canonicalizeUrlForDedup — robustness', () => {
  test('returns empty string on null/undefined/empty', () => {
    assert.strictEqual(canonicalizeUrlForDedup(null), '');
    assert.strictEqual(canonicalizeUrlForDedup(undefined), '');
    assert.strictEqual(canonicalizeUrlForDedup(''), '');
    assert.strictEqual(canonicalizeUrlForDedup('   '), '');
  });

  test('returns empty string on non-string types', () => {
    assert.strictEqual(canonicalizeUrlForDedup(123), '');
    assert.strictEqual(canonicalizeUrlForDedup({}), '');
    assert.strictEqual(canonicalizeUrlForDedup([]), '');
  });

  test('falls back gracefully on un-parseable URL (no throw)', () => {
    const out = canonicalizeUrlForDedup('not-a-url-but-a-string-anyway');
    assert.strictEqual(typeof out, 'string');
    // Must not throw; result is best-effort.
    assert.strictEqual(out, 'not-a-url-but-a-string-anyway');
  });

  test('trims whitespace before parsing', () => {
    const a = canonicalizeUrlForDedup('   https://example.com/x   ');
    const b = canonicalizeUrlForDedup('https://example.com/x');
    assert.strictEqual(a, b);
  });
});

describe('canonicalizeUrlForDedup — tracking param registry', () => {
  test('TRACKING_PARAM_NAMES includes the Cote Notices-triggering param', () => {
    assert.ok(TRACKING_PARAM_NAMES.has('triedredirect'),
      'triedredirect must be in the registry — this is the param that caused Rocky Horror 2026-04-23');
  });

  test('TRACKING_PARAM_PREFIXES covers utm_ and mc_', () => {
    assert.ok(TRACKING_PARAM_PREFIXES.includes('utm_'));
    assert.ok(TRACKING_PARAM_PREFIXES.includes('mc_'));
  });
});
