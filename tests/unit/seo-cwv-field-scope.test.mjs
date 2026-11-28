/**
 * Page-level vs origin-fallback CrUX scope (card #419).
 *
 * Background: PSI returns `loadingExperience` for every audited URL, but the block
 * is the ORIGIN's data whenever the page itself has too few CrUX samples — same
 * response shape, no error. check-seo-health.js stored it as the page's own number.
 *
 * The fixtures below are the REAL values from data/audit/seo-performance-history.json,
 * so these tests fail if the derivation stops matching production data:
 *   2026-07-19 — /west-end had page-level data (2512ms) while the other four URLs
 *                all reported the same origin value (1455ms).
 *   2026-08-02 — /west-end fell below the CrUX sampling floor; all five URLs report
 *                the identical origin value (1467ms). The 1045ms "improvement" is a
 *                measurement swap, not a page change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { annotateFieldScope, fieldScopeFor, scopeChanged } = require('../../scripts/lib/seo-cwv-field-scope.js');
const HOST = 'https://broadwayscorecard.com';

// Real 2026-07-19 snapshot: /west-end genuinely had its own field data.
const WEEK_2026_07_19 = [
  { url: `${HOST}/`, lcp: 1455, inp: 111, cls: 0, performanceScore: 71 },
  { url: `${HOST}/browse/best-broadway-musicals`, lcp: 1455, inp: 111, cls: 0, performanceScore: 69 },
  { url: `${HOST}/show/hamilton`, lcp: 1455, inp: 111, cls: 0, performanceScore: 68 },
  { url: `${HOST}/west-end`, lcp: 2512, inp: null, cls: 0, performanceScore: 69 },
  { url: `${HOST}/off-broadway`, lcp: 1455, inp: 111, cls: 0, performanceScore: 72 },
];

// Real 2026-08-02 snapshot: every URL reports the same origin value.
const WEEK_2026_08_02 = [
  { url: `${HOST}/`, lcp: 1467, inp: 112, cls: 0, performanceScore: 95 },
  { url: `${HOST}/guides/best-broadway-musicals`, lcp: 1467, inp: 112, cls: 0, performanceScore: 94 },
  { url: `${HOST}/show/hamilton`, lcp: 1467, inp: 112, cls: 0, performanceScore: 69 },
  { url: `${HOST}/west-end`, lcp: 1467, inp: 112, cls: 0, performanceScore: 76 },
  { url: `${HOST}/off-broadway`, lcp: 1467, inp: 112, cls: 0, performanceScore: 92 },
];

describe('annotateFieldScope — page-level vs origin fallback', () => {
  test('2026-07-19: the one unique field triple is page-level, the shared one is the origin', () => {
    const scoped = annotateFieldScope(WEEK_2026_07_19);
    const byUrl = Object.fromEntries(scoped.map(r => [r.url, r.fieldScope]));

    assert.strictEqual(byUrl[`${HOST}/west-end`], 'url', '2512ms was /west-end\'s own measurement');
    for (const u of ['/', '/browse/best-broadway-musicals', '/show/hamilton', '/off-broadway']) {
      assert.strictEqual(byUrl[`${HOST}${u}`], 'origin', `${u} shares the 1455ms origin value`);
    }
  });

  test('2026-08-02: every URL reports the same value, so all five are origin fallback', () => {
    const scoped = annotateFieldScope(WEEK_2026_08_02);
    assert.ok(scoped.every(r => r.fieldScope === 'origin'), 'five identical field triples cannot be five page measurements');
  });

  test('PSI\'s own origin_fallback marker wins over the inference', () => {
    // Two URLs with the same value would infer 'origin', but PSI says otherwise.
    const scoped = annotateFieldScope([
      { url: `${HOST}/a`, lcp: 1200, inp: 100, cls: 0, originFallback: false },
      { url: `${HOST}/b`, lcp: 1200, inp: 100, cls: 0, originFallback: false },
    ]);
    assert.deepStrictEqual(scoped.map(r => r.fieldScope), ['url', 'url']);
  });

  test('a single-URL run is not disambiguable — stays unknown so callers keep old behaviour', () => {
    const scoped = annotateFieldScope([{ url: `${HOST}/west-end`, lcp: 2512, inp: null, cls: 0 }]);
    assert.strictEqual(scoped[0].fieldScope, 'unknown');
  });

  test('records with no field data at all are unknown, not origin', () => {
    const scoped = annotateFieldScope([
      { url: `${HOST}/a`, lcp: null, inp: null, cls: null },
      { url: `${HOST}/b`, lcp: null, inp: null, cls: null },
    ]);
    assert.ok(scoped.every(r => r.fieldScope === 'unknown'));
  });

  test('does not mutate the input records', () => {
    const input = [{ url: `${HOST}/a`, lcp: 1, inp: 1, cls: 0 }, { url: `${HOST}/b`, lcp: 1, inp: 1, cls: 0 }];
    annotateFieldScope(input);
    assert.ok(!('fieldScope' in input[0]), 'annotation must return new objects');
  });

  test('fieldScopeFor resolves one URL inside its run', () => {
    assert.strictEqual(fieldScopeFor(WEEK_2026_07_19, `${HOST}/west-end`), 'url');
    assert.strictEqual(fieldScopeFor(WEEK_2026_07_19, `${HOST}/show/hamilton`), 'origin');
    assert.strictEqual(fieldScopeFor(WEEK_2026_07_19, `${HOST}/nope`), 'unknown');
  });
});

describe('scopeChanged — week-over-week comparability', () => {
  test('/west-end url → origin between the two real weeks is a swap, not a change', () => {
    const before = fieldScopeFor(WEEK_2026_07_19, `${HOST}/west-end`);
    const after = fieldScopeFor(WEEK_2026_08_02, `${HOST}/west-end`);
    assert.strictEqual(before, 'url');
    assert.strictEqual(after, 'origin');
    assert.strictEqual(scopeChanged(after, before), true);
  });

  test('same scope both weeks stays comparable', () => {
    assert.strictEqual(scopeChanged('origin', 'origin'), false);
    assert.strictEqual(scopeChanged('url', 'url'), false);
  });

  test('unknown on either side stays comparable — pre-annotation history must not change behaviour', () => {
    assert.strictEqual(scopeChanged('unknown', 'url'), false);
    assert.strictEqual(scopeChanged('origin', 'unknown'), false);
    assert.strictEqual(scopeChanged(undefined, 'url'), false);
  });
});
