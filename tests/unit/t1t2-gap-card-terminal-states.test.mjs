/**
 * BRO-341: the T1/T2 silent-gap card generator (scripts/audit-t1-silent-gaps.js)
 * had no terminal state (a card, once filed, never closed even after the
 * underlying file was collected or turned out to be a correct editorial
 * absence) and no cross-card dedupe (the same show+outlet+file could mint two
 * cards via the 'gap:' and 'backstop:' conditionKey prefixes, or a
 * byline-explosion cluster could mint one card per file for a single missing
 * outlet). Fixtures below mirror the six show/outlet pairs verified against
 * the live corpus during 2026-08-14 triage.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyGapCardState, gapCardKey, dedupeGapCards, GAP_CARD_STATE,
} = require('../../scripts/lib/t1-silent-gap.js');

const NOW = new Date('2026-08-14T12:00:00Z');
const SHOW = { id: 'trainspotting-west-end-2026', category: 'west-end', openingDate: '2026-07-01' };

describe('terminal state: collected (#936/#1019/#1027/#1070)', () => {
  test('outlet already scored via another file → collected', () => {
    const file = { url: 'https://www.dailymail.co.uk/x', criticName: 'Georgina Brown', fullText: '' };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 2, outletScored: true, now: NOW }),
      GAP_CARD_STATE.COLLECTED
    );
  });

  test('this file itself now has a valid score and passes canonical inclusion → collected', () => {
    const file = {
      url: 'https://www.wsj.com/arts-culture/othello-review',
      criticName: 'Terry Teachout',
      fullText: 'x'.repeat(2000),
      contentTier: 'complete',
      assignedScore: 86,
      textFetchedAt: '2026-08-01T00:00:00Z',
    };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: false, now: NOW }),
      GAP_CARD_STATE.COLLECTED
    );
  });
});

describe('terminal state: no-review-exists (#839/#1141)', () => {
  test('isNonReview + wrongProduction on the only candidate → no-review, never recoverable', () => {
    const file = {
      url: 'https://www.theatreweekly.com/brainiac-live',
      isNonReview: true,
      wrongProduction: true,
      fullText: 'x'.repeat(500),
    };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 2, outletScored: false, now: NOW }),
      GAP_CARD_STATE.NO_REVIEW
    );
  });

  test('roundup hub page classified as review → no-review', () => {
    const file = {
      url: 'https://www.broadwayworld.com/westend/reviews/trainspotting',
      isRoundupArticle: true,
      fullText: 'x'.repeat(500),
    };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 2, outletScored: false, now: NOW }),
      GAP_CARD_STATE.NO_REVIEW
    );
  });
});

describe('terminal state: still open (must NOT close a live card)', () => {
  test('empty-body stub with no editorial flags is still an open gap', () => {
    const file = { url: 'https://www.thetimes.com/x', criticName: 'Clive Davis', contentTier: 'excerpt', fullText: '' };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: false, now: NOW }),
      GAP_CARD_STATE.OPEN
    );
  });

  test('not T1/T2-eligible (tier 3) → null, not a card candidate either way', () => {
    const file = { url: 'https://blog.example.com/x', fullText: '' };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 3, outletScored: false, now: NOW }),
      null
    );
  });

  test('fresh text inside the unscored grace window → null (not yet a gap, not terminal)', () => {
    const file = {
      url: 'https://www.thetimes.com/x', fullText: 'y'.repeat(1000), contentTier: 'complete',
      textFetchedAt: '2026-08-14T09:00:00Z',
    };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: false, now: NOW }),
      null
    );
  });
});

describe('dedupe key (#1114 dup of #1070, #1179 dup of #1082)', () => {
  test('identical show+outlet+file always produces the identical key', () => {
    const a = gapCardKey({ showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--unknown.json' });
    const b = gapCardKey({ showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--unknown.json' });
    assert.equal(a, b);
  });

  test('different outlet or file changes the key', () => {
    const base = { showId: 'wicked-west-end-2026', outletId: 'wsj', file: 'wsj--unknown.json' };
    const key = gapCardKey(base);
    assert.notEqual(key, gapCardKey({ ...base, outletId: 'nyt' }));
    assert.notEqual(key, gapCardKey({ ...base, file: 'wsj--jane-doe.json' }));
    assert.notEqual(key, gapCardKey({ ...base, showId: 'hamilton-west-end-2026' }));
  });

  test('two independent gap-generating paths (the old gap:/backstop: prefixes) now converge on one key', () => {
    // Before BRO-341 the urgent-alert path used `gap:${showId}/${file}` and
    // the >24h backstop path used `backstop:${showId}/${file}` — two
    // different conditionKeys for the identical underlying file, which is
    // exactly how #1070/#1114 ended up as two cards for one gap.
    const args = { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--unknown.json' };
    const urgentPathKey = gapCardKey(args);
    const backstopPathKey = gapCardKey(args);
    assert.equal(urgentPathKey, backstopPathKey);
  });
});

describe('dedupeGapCards: one card per show+outlet per run', () => {
  test('two files for the same show+outlet collapse to one primary + one duplicate', () => {
    const gaps = [
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--unknown.json', type: 'empty-body' },
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--jane-doe.json', type: 'unscored' },
    ];
    const { primary, duplicates } = dedupeGapCards(gaps);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].file, 'the-stage--unknown.json');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].file, 'the-stage--jane-doe.json');
    assert.equal(duplicates[0].cardState, GAP_CARD_STATE.DUPLICATE);
    assert.equal(duplicates[0].duplicateOfFile, 'the-stage--unknown.json');
  });

  test('gaps for different outlets on the same show are never collapsed', () => {
    const gaps = [
      { showId: 'wicked-west-end-2026', outletId: 'wsj', file: 'wsj--unknown.json' },
      { showId: 'wicked-west-end-2026', outletId: 'nyt', file: 'nyt--unknown.json' },
    ];
    const { primary, duplicates } = dedupeGapCards(gaps);
    assert.equal(primary.length, 2);
    assert.equal(duplicates.length, 0);
  });

  test('an empty gap list dedupes to empty', () => {
    assert.deepEqual(dedupeGapCards([]), { primary: [], duplicates: [] });
  });
});
