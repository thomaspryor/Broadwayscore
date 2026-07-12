/**
 * evaluateCurrentRunCorroboration — the pure decision behind the
 * corroboration guard in flag-wrong-production-by-date.js and
 * rebuild-all-reviews.js (pre-window passes).
 *
 * Incident fixture: care-west-end-2026 The Stage review stamped 2023-10-12
 * (misparse; live page 2026-05-20, Theatre Record 2026/5) was auto-flagged
 * wrongProduction, suppressing a legit current-run T1 review (2026-07-11).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { evaluateCurrentRunCorroboration } = require('./wrong-production-corroboration.js');

// care-west-end-2026 run window (previews 2026-05-11, closing 2026-06-20)
const CARE = {
  id: 'care-west-end-2026',
  previewsStartDate: '2026-05-11',
  openingDate: '2026-05-20',
  closingDate: '2026-06-20',
  category: 'west-end',
};

describe('evaluateCurrentRunCorroboration', () => {
  test('care incident: old publishDate + TR month inside run window → strong (flag HELD)', () => {
    const r = evaluateCurrentRunCorroboration({
      review: {
        publishDate: '2023-10-12',
        theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
      },
      show: CARE,
    });
    assert.equal(r.strength, 'strong');
    assert.deepEqual(r.signals, ['theatre-record-month:2026/5']);
  });

  test('TR month OUTSIDE run window → no TR signal (a-strange-loop WE-transfer case)', () => {
    // Broadway run closed 2023-01-15; TR 2023/6 is the West End transfer —
    // the flag on the Broadway show is CORRECT and must not be held.
    const r = evaluateCurrentRunCorroboration({
      review: {
        publishDate: '2023-07-01',
        theatreRecordUrl: 'https://www.theatrerecord.com/archive/2023/6/5447-a-strange-loop',
      },
      show: {
        previewsStartDate: '2022-04-14',
        openingDate: '2022-04-26',
        closingDate: '2023-01-15',
      },
    });
    assert.equal(r.strength, null);
    assert.deepEqual(r.signals, []);
  });

  test('volume/issue TR URL shapes carry no date → no TR signal', () => {
    for (const url of [
      'https://www.theatrerecord.com/archive/volume/23/page/1015',
      'https://www.theatrerecord.com/archive/issue/425#page=20',
    ]) {
      const r = evaluateCurrentRunCorroboration({
        review: { theatreRecordUrl: url },
        show: CARE,
      });
      assert.equal(r.strength, null, url);
    }
  });

  test('open-ended show (no closingDate): TR month after opening → strong', () => {
    const r = evaluateCurrentRunCorroboration({
      review: { theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/6/12345-x' },
      show: { previewsStartDate: '2026-01-10', openingDate: '2026-01-20' },
    });
    assert.equal(r.strength, 'strong');
  });

  test('roundup excerpt fields alone → weak (flag proceeds, warning emitted)', () => {
    for (const field of ['theatreReviewsExcerpt', 'theStageExcerpt', 'lboRoundupExcerpt']) {
      const r = evaluateCurrentRunCorroboration({
        review: { publishDate: '2019-06-12', [field]: 'quoted in current roundup…' },
        show: CARE,
      });
      assert.equal(r.strength, 'weak', field);
      assert.deepEqual(r.signals, [`roundup-excerpt:${field}`]);
    }
  });

  test('TR-in-window + excerpts → strong wins, all signals reported', () => {
    const r = evaluateCurrentRunCorroboration({
      review: {
        theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
        theStageExcerpt: 'quoted…',
      },
      show: CARE,
    });
    assert.equal(r.strength, 'strong');
    assert.equal(r.signals.length, 2);
  });

  test('aggregatorStars alone is NOT corroboration (article-page sourced, exists on prior-run reviews)', () => {
    const r = evaluateCurrentRunCorroboration({
      review: { publishDate: '2018-09-26', aggregatorStars: '4/5 stars', aggregatorStarsSource: 'stage-star-svg' },
      show: CARE,
    });
    assert.equal(r.strength, null);
  });

  test('no corroboration fields → null (flag proceeds as before)', () => {
    const r = evaluateCurrentRunCorroboration({
      review: { publishDate: '2009-04-09' },
      show: CARE,
    });
    assert.equal(r.strength, null);
  });

  test('missing show / dateless show → no TR signal, excerpts still weak', () => {
    assert.equal(evaluateCurrentRunCorroboration({
      review: { theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/1-x' },
      show: null,
    }).strength, null);
    assert.equal(evaluateCurrentRunCorroboration({
      review: { theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/1-x', theStageExcerpt: 'q' },
      show: {},
    }).strength, 'weak');
  });
});
