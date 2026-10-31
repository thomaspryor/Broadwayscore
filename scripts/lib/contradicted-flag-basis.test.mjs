import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectContradictedFlagBasis, citedBasisDate } = require('./contradicted-flag-basis.js');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const AUDIT_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'audit-contradicted-flag-basis.js'
);

// carousel-2018/vulture--sara-holdren.json, the real corpus shape: a Vulture
// review of the 2018 Carousel, dated inside the 2018 run, flagged because a
// date guard once read 2019-04-24.
const CAROUSEL_SHOW = {
  id: 'carousel-2018',
  previewsStartDate: '2018-02-28',
  openingDate: '2018-04-12',
  closingDate: '2018-09-16',
};
const CAROUSEL_REVIEW = {
  url: 'http://www.vulture.com/2018/04/theater-review-can-carousel-be-brought-around.html',
  publishDate: 'April 12th, 2018',
  wrongProduction: true,
  wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production',
};

test('flags a date-only basis whose cited date the record no longer carries', () => {
  const v = detectContradictedFlagBasis({ review: CAROUSEL_REVIEW, show: CAROUSEL_SHOW });
  assert.equal(v.contradicted, true);
  assert.deepEqual(v.flags, ['wrongProduction']);
  assert.deepEqual(v.citedDates, ['2019-04-24']);
  assert.equal(v.currentDate, '2018-04-12');
});

test('silent when the basis still describes the record\'s current date', () => {
  const v = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: '2019-04-24' },
    show: CAROUSEL_SHOW,
  });
  assert.equal(v.contradicted, false);
});

test('silent when the record\'s current date is OUTSIDE the run window', () => {
  // Date moved, but to a date that is still not this production's — the flag
  // may well be right, so this module must say nothing.
  const v = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: '2013-08-01' },
    show: CAROUSEL_SHOW,
  });
  assert.equal(v.contradicted, false);
});

test('in-window is inclusive of closing + the 7-day date-guard grace', () => {
  const inGrace = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: '2018-09-23' },
    show: CAROUSEL_SHOW,
  });
  assert.equal(inGrace.contradicted, true, '2018-09-16 + 7d must still count as in-window');
  const past = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: '2018-09-24' },
    show: CAROUSEL_SHOW,
  });
  assert.equal(past.contradicted, false, 'one day past the grace is out of window');
});

test('a show with no closingDate has an open-ended window', () => {
  const v = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: '2026-01-01' },
    show: { id: 'x', previewsStartDate: '2018-02-28', openingDate: '2018-04-12' },
  });
  assert.equal(v.contradicted, true);
});

for (const extra of [
  'Collector LLM: wrong production (high) — the scraped content is a different show',
  'CV-promoted: this is a news article, not a review',
  'Cross-market: US outlet reviewing London show',
  'Dateless revival guard: no publishDate on multi-production title',
  'Same URL as another production entry',
]) {
  test(`silent when a non-date basis is also attached: ${extra.slice(0, 28)}…`, () => {
    const v = detectContradictedFlagBasis({
      review: { ...CAROUSEL_REVIEW, wrongProductionReason: extra },
      show: CAROUSEL_SHOW,
    });
    assert.equal(v.contradicted, false,
      'a flag resting on content/market/collision evidence is not refuted by a date');
  });
}

for (const human of [
  { humanReviewedWrongProduction: true },
  { wrongProductionProvenance: 'manual' },
  { humanReviewScore: 40 },
]) {
  test(`silent when a human asserted the flag (${Object.keys(human)[0]})`, () => {
    const v = detectContradictedFlagBasis({
      review: { ...CAROUSEL_REVIEW, ...human },
      show: CAROUSEL_SHOW,
    });
    assert.equal(v.contradicted, false);
  });
}

test('silent when the current date is an LLM guess (dateSource llm-scoring)', () => {
  // Same carve-out as scripts/lib/date-plausibility.js: a hallucinated date
  // must never move a flag in either direction.
  const v = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, dateSource: 'llm-scoring' },
    show: CAROUSEL_SHOW,
  });
  assert.equal(v.contradicted, false);
});

test('silent when no exclusion flag is live', () => {
  const v = detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, wrongProduction: false },
    show: CAROUSEL_SHOW,
  });
  assert.equal(v.contradicted, false);
});

test('silent with a missing show or missing publishDate', () => {
  assert.equal(detectContradictedFlagBasis({ review: CAROUSEL_REVIEW }).contradicted, false);
  assert.equal(detectContradictedFlagBasis({
    review: { ...CAROUSEL_REVIEW, publishDate: null }, show: CAROUSEL_SHOW,
  }).contradicted, false);
});

test('reads a wrongShow flag from its own basis field', () => {
  const v = detectContradictedFlagBasis({
    review: {
      publishDate: '2018-04-12',
      wrongShow: true,
      wrongShowReason: 'Pre-opening guard: review dated 2016-01-02 is 60+ days before show starts 2018-02-28',
    },
    show: CAROUSEL_SHOW,
  });
  assert.equal(v.contradicted, true);
  assert.deepEqual(v.flags, ['wrongShow']);
});

// REGRESSION GUARD. The predecessor gate (#483,
// audit-stale-flag-after-url-correction.js) fired on "_urlChangedClear
// breadcrumb + no fullText" and was measured at 0/120 precision: a URL
// correction routinely swaps in a DIFFERENT production's article, after which
// the guards re-flag the record correctly. If anyone folds that signature back
// into this detector, this test fails.
test('the #483 signature alone is NOT a contradiction', () => {
  const v = detectContradictedFlagBasis({
    review: {
      publishDate: '2024-11-21',
      fullText: null,
      needsRefetch: true,
      wrongProduction: true,
      wrongProductionNote: 'Pre-opening guard: review dated 2024-11-21 is 60+ days before show starts 2026-11-24',
      _urlChangedClear: { from: 'https://a', to: 'https://b', at: '2026-08-08T06:14:01.051Z', cleared: ['wrongProduction', 'publishDate'] },
    },
    show: { id: 'a-christmas-carol-west-end-2026', previewsStartDate: '2026-11-12', openingDate: '2026-11-24' },
  });
  assert.equal(v.contradicted, false,
    'breadcrumb + empty body is not evidence of staleness — that is the retired rule');
});

test('citedBasisDate parses every basis shape the two date writers emit', () => {
  assert.equal(citedBasisDate('Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production'), '2019-04-24');
  assert.equal(citedBasisDate('Date guard: review March 19th, 2025 is 307d before 2026-02-24 (preview/open) — likely different production'), '2025-03-19');
  assert.equal(citedBasisDate('Pre-opening guard: review dated 2024-05-29 is 60+ days before show starts 2026-07-09'), '2024-05-29');
  assert.equal(citedBasisDate('Pre-opening guard: pre-window date — review dated 2020-12-18 is 60+ days before show starts 2026-11-24'), '2020-12-18');
  assert.equal(citedBasisDate('Collector LLM: not a review'), null);
});

// --max must never silently disable the gate: parseInt('abc') is NaN and
// `hits.length > NaN` is always false, so a typo'd ceiling in test.yml would
// turn a blocking gate into a passing no-op. Same guard the #483 audit carries.
test('audit --max with a non-integer value exits 2 instead of disabling the gate', () => {
  for (const bad of ['--max=abc', '--max=', '--max=1.5', '--max=-1', '--max=12x']) {
    const r = spawnSync(process.execPath, [AUDIT_SCRIPT, '--gate', bad, '--review-texts-dir=/nonexistent'], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${bad} should exit 2, got ${r.status}`);
  }
});

test('audit --gate refuses to pass when the corpus was never checked out', () => {
  const r = spawnSync(process.execPath,
    [AUDIT_SCRIPT, '--gate', '--max=12', '--review-texts-dir=/nonexistent'], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'an unscanned corpus must fail, not report a clean sweep');
});

// The gate has TWO inputs. A missing shows.json makes every detection return
// false (no run window ⇒ no verdict), so without this check the gate would
// report a clean corpus and pass — the same silent no-op corpus-scan-guard
// prevents on the review-texts side.
test('audit --gate refuses to pass when shows.json is missing', () => {
  const r = spawnSync(process.execPath,
    [AUDIT_SCRIPT, '--gate', '--max=12', '--shows-path=/nonexistent/shows.json'], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'no show records must fail, not report a clean sweep');
  assert.match(r.stderr, /cannot pass vacuously/);
});
