/**
 * BRO-7815: cross-show URL ownership must not hide a correct review.
 * Cases are the real mis-homings found in the review-texts audit (2026-11-19).
 *
 * Run: node --test tests/unit/url-cross-production-bro7815.test.mjs
 * Per CLAUDE.md §15 these require() the real functions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldTakeUrlOwnership, classifyCrossShowUrlFlag, showRunYears, sameShowTitle, yearDistance,
} = require('../../scripts/lib/url-cross-production.js');

const lionKing = { id: 'the-lion-king-1997', title: 'The Lion King', openingDate: '1997-11-13', closingDate: null };
const thirteen = { id: '13-2008', title: '13', openingDate: '2008-10-05', closingDate: '2009-01-04' };
const beautifulBway = { id: 'beautiful-the-carole-king-musical-2014', title: 'Beautiful: The Carole King Musical', openingDate: '2014-01-12', closingDate: '2019-10-27' };
const beautifulWE = { id: 'beautiful-the-carole-king-musical-west-end-2015', title: 'Beautiful: The Carole King Musical', openingDate: '2015-02-24', closingDate: '2017-08-26' };
const liaisons2016 = { id: 'les-liaisons-dangereuses-2016', title: 'Les Liaisons Dangereuses', openingDate: '2016-10-30', closingDate: '2017-01-22' };
const liaisonsWE = { id: 'les-liaisons-dangereuses-west-end-2026', title: 'Les Liaisons Dangereuses', openingDate: '2026-04-01', closingDate: null };

describe('shouldTakeUrlOwnership (BRO-7815 inputs)', () => {
  test('never re-homes across different titles (EW Lion King review -> "13")', () => {
    assert.strictEqual(sameShowTitle(thirteen, lionKing), false);
    // 2010 revisit: year-only distance favours 13 (2008), the bug.
    assert.strictEqual(shouldTakeUrlOwnership({ reviewYear: 2010, thisYear: 2008, existingYear: 1997 }), true);
    assert.strictEqual(shouldTakeUrlOwnership({ reviewYear: 2010, thisYear: 2008, existingYear: 1997, sameTitle: false }), false);
  });

  test('a long run owns reviews written while it played (Beautiful 2018 revisit)', () => {
    const args = { reviewYear: 2018, thisYear: 2015, existingYear: 2014 };
    assert.strictEqual(shouldTakeUrlOwnership(args), true); // old rule: 3 < 4
    assert.strictEqual(shouldTakeUrlOwnership({
      ...args, thisRun: showRunYears(beautifulWE, 2026), existingRun: showRunYears(beautifulBway, 2026), sameTitle: true,
    }), false);
  });

  test('the incumbent copy\'s own date vetoes a move its date does not support (Les Liaisons)', () => {
    // Incoming copy was dated for the 2026 West End show that found it.
    const args = { reviewYear: 2026, thisYear: 2026, existingYear: 2016, thisRun: showRunYears(liaisonsWE, 2026), existingRun: showRunYears(liaisons2016, 2026), sameTitle: true };
    assert.strictEqual(shouldTakeUrlOwnership(args), true);
    assert.strictEqual(shouldTakeUrlOwnership({ ...args, existingReviewYear: 2016 }), false);
  });

  test('a real revival review still moves when every signal agrees', () => {
    assert.strictEqual(shouldTakeUrlOwnership({
      reviewYear: 2026, thisYear: 2026, existingYear: 2016,
      thisRun: showRunYears(liaisonsWE, 2026), existingRun: showRunYears(liaisons2016, 2026),
      sameTitle: true, existingReviewYear: 2026,
    }), true);
  });

  test('run distance is 0 inside the run, the gap to the nearer end outside it', () => {
    assert.strictEqual(yearDistance(2018, 2014, { from: 2014, to: 2019 }), 0);
    assert.strictEqual(yearDistance(2010, 2015, { from: 2015, to: 2017 }), 5);
    assert.strictEqual(yearDistance(2020, 2015, { from: 2015, to: 2017 }), 3);
    assert.strictEqual(yearDistance(2020, 2015, null), 5);
  });
});

describe('showRunYears', () => {
  test('a missing closing date stretches the run only while the show is playing', () => {
    assert.deepStrictEqual(showRunYears({ openingDate: '1997-11-13', closingDate: null, status: 'open' }, 2026), { from: 1997, to: 2026 });
    assert.deepStrictEqual(showRunYears({ openingDate: '2015-12-02', closingDate: null, status: 'closed' }, 2026), { from: 2015, to: 2015 });
    assert.deepStrictEqual(showRunYears({ openingDate: '2014-01-12', closingDate: '2019-10-27', status: 'closed' }, 2026), { from: 2014, to: 2019 });
    assert.strictEqual(showRunYears({ openingDate: null }), null);
  });

  test('without run windows the rebuild comparison is the old opening-year rule', () => {
    const { otherFitsReviewYearBetter } = require('../../scripts/lib/url-cross-production.js');
    assert.strictEqual(otherFitsReviewYearBetter(2016, { openYear: 2015 }, { openYear: 2015 }), false);
    assert.strictEqual(otherFitsReviewYearBetter(2018, { openYear: 2014 }, { openYear: 2015 }), true);
    assert.strictEqual(otherFitsReviewYearBetter(2018, { openYear: 2014, run: { from: 2014, to: 2019 } }, { openYear: 2015, run: { from: 2015, to: 2017 } }), false);
  });
});

describe('sameShowTitle', () => {
  test('accents, & / + and possessive prefixes are the same title (second-opinion catch)', () => {
    assert.strictEqual(sameShowTitle({ title: 'Les Miserables' }, { title: 'Les Misérables' }), true);
    assert.strictEqual(sameShowTitle({ title: 'Romeo and Juliet' }, { title: 'Romeo + Juliet' }), true);
    assert.strictEqual(sameShowTitle({ title: 'Romeo and Juliet' }, { title: 'Romeo & Juliet' }), true);
    assert.strictEqual(sameShowTitle({ title: 'Old Friends' }, { title: "Stephen Sondheim's Old Friends" }), true);
  });

  test('ignores a trailing "The Musical" and a leading "Disney\'s"/"The"', () => {
    assert.strictEqual(sameShowTitle({ title: 'Kinky Boots' }, { title: 'Kinky Boots: The Musical' }), true);
    assert.strictEqual(sameShowTitle({ title: "Disney's Frozen" }, { title: 'Frozen' }), true);
    assert.strictEqual(sameShowTitle({ title: 'Chess' }, { title: 'Spare Parts' }), false);
    assert.strictEqual(sameShowTitle({ title: '' }, { title: 'Chess' }), null);
  });
});

describe('classifyCrossShowUrlFlag (advisory class guard)', () => {
  const flag = (showId, other, publishDate) => ({ showId, wrongProduction: true, wrongProductionNote: `Same URL correctly belongs in ${other}`, publishDate });

  test('flags a different-title move', () => {
    const r = classifyCrossShowUrlFlag(flag(lionKing.id, thirteen.id, null), lionKing, thirteen, 2026);
    assert.deepStrictEqual([r.flagged, r.suspect, r.reasons], [true, true, ['different-title']]);
  });

  test('flags a file whose own date sits in its own run only', () => {
    const r = classifyCrossShowUrlFlag(flag(liaisons2016.id, liaisonsWE.id, 'October 31st, 2016'), liaisons2016, liaisonsWE, 2026);
    assert.ok(r.suspect);
    assert.deepStrictEqual(r.reasons, ['own-date-fits-own-run']);
  });

  test('flags a note naming a show that is not in shows.json', () => {
    const r = classifyCrossShowUrlFlag(flag('paranormal-activity-west-end-2025', 'alice-in-wonderland-west-end-2026', '2025-12-15'), { title: 'Paranormal Activity', openingDate: '2025-12-14' }, undefined, 2026);
    assert.ok(r.reasons.includes('other-show-missing'));
  });

  test('leaves a flag its own date supports', () => {
    const r = classifyCrossShowUrlFlag(flag(liaisonsWE.id, liaisons2016.id, '2016-10-31'), liaisonsWE, liaisons2016, 2026);
    assert.deepStrictEqual([r.flagged, r.suspect], [true, false]);
  });

  test('ignores cleared files and other notes', () => {
    assert.strictEqual(classifyCrossShowUrlFlag({ ...flag(liaisons2016.id, liaisonsWE.id, '2016'), wrongProduction: false }, liaisons2016, liaisonsWE).flagged, false);
    assert.strictEqual(classifyCrossShowUrlFlag({ wrongProduction: true, wrongProductionNote: 'Text reviews the 2008 production' }, liaisons2016, liaisonsWE).flagged, false);
  });
});

test('overlapping runs: opening-year tie-break re-homes like rebuild does (ship-check P1)', () => {
  const L = require('../../scripts/lib/url-cross-production.js');
  // Long-runner 1997-now vs tour 2021-now, review 2021: both distance 0.
  const longRun = { from: 1997, to: 2026 }, tour = { from: 2021, to: 2026 };
  assert.equal(L.shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2021, existingYear: 1997, thisRun: tour, existingRun: longRun }), true);
  assert.equal(L.otherFitsReviewYearBetter(2021, { openYear: 1997, run: longRun }, { openYear: 2021, run: tour }), true);
  // Reverse direction must not re-home back.
  assert.equal(L.shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 1997, existingYear: 2021, thisRun: longRun, existingRun: tour }), false);
  // Incumbent-date veto with a tie also uses the tie-break: incumbent dated 2021 agrees.
  assert.equal(L.shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2021, existingYear: 1997, thisRun: tour, existingRun: longRun, existingReviewYear: 2022 }), true);
  // Incumbent dated 1998 (only the long-runner was open) vetoes.
  assert.equal(L.shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2021, existingYear: 1997, thisRun: tour, existingRun: longRun, existingReviewYear: 1998 }), false);
  // sameTitle null does not veto.
  assert.equal(L.shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2021, existingYear: 1997, thisRun: tour, existingRun: longRun, sameTitle: null }), true);
});
