// scripts/tests/stale-wrongproduction-adjudication.test.mjs
//
// Regression test for card #1589 ("Adjudicate 13 stale wrongProduction flags
// (contradicted date basis)"). The 13 review-text records the card named all
// carried wrongProduction:true whose ONLY stated basis was a date-guard claim
// citing a date the record no longer has, while the record's CURRENT
// publishDate sat inside the show's own run window — the flag's own stated
// basis was contradicted by the record. All 13 were cleared this session via
// scripts/clear-contradicted-flag-basis.js.
//
// Per CLAUDE.md rule 15, this does NOT reimplement the date-basis adjudication
// logic here — it require()s the real exported flag-evaluation function,
// scripts/lib/contradicted-flag-basis.js detectContradictedFlagBasis(), the
// same pure detector both scripts/audit-contradicted-flag-basis.js (the CI
// gate) and scripts/clear-contradicted-flag-basis.js (the clearing script)
// call. A future change to that detector's logic should fail this test.
//
// Fixtures are synthetic (shaped like the real corpus records, e.g. the
// carousel-2018/vulture--sara-holdren.json case cited in the detector's own
// docblock) rather than reads of the private review-texts corpus, so this
// test runs identically in CI (which has no access to that private repo) and
// locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictedFlagBasis } from '../lib/contradicted-flag-basis.js';

const CAROUSEL_SHOW = {
  id: 'carousel-2018',
  openingDate: '2018-04-12',
  previewsStartDate: '2018-02-28',
  closingDate: '2018-09-16',
};

test('a wrongProduction flag whose basis cites a date the record no longer has, inside the run window, IS contradicted (should clear)', () => {
  const review = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production',
    publishDate: '2018-04-12',
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, true);
  assert.deepEqual(verdict.citedDates, ['2019-04-24']);
  assert.equal(verdict.currentDate, '2018-04-12');
});

test('a wrongProduction flag whose current date is genuinely OUTSIDE the run window is NOT contradicted (should stand)', () => {
  // Same shape as the clearable case above, but the record's current
  // publishDate is a year before the run ever opened — a real prior-production
  // review, not a stale flag. This is the negative twin of the #1589 class:
  // the detector must not clear a genuinely different-production review just
  // because its basis is a pure date-guard claim.
  const review = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production',
    publishDate: '2017-01-01',
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, false);
});

test('a flag whose basis cites the SAME date as the record currently carries is NOT contradicted (basis still describes this record)', () => {
  const review = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production',
    publishDate: '2019-04-24',
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, false);
});

test('a flag whose basis also cites non-date evidence (content/LLM verdict) is NOT contradicted — a date cannot refute it', () => {
  const review = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production; Collector LLM: cast names do not match this production',
    publishDate: '2018-04-12',
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, false);
});

test('a human-asserted wrongProduction flag is NEVER contradicted by a re-derived date', () => {
  const review = {
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 2019-04-24 is 213d after 2018-09-16 (close+7d) — likely different production',
    publishDate: '2018-04-12',
    humanReviewedWrongProduction: true,
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, false);
});

test('a record with no live wrongProduction/wrongShow flag is NOT contradicted (nothing to clear)', () => {
  const review = {
    wrongProduction: false,
    publishDate: '2018-04-12',
  };
  const verdict = detectContradictedFlagBasis({ review, show: CAROUSEL_SHOW });
  assert.equal(verdict.contradicted, false);
});
