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
  classifyGapCardState, gapCardKey, otherAlertPathKey, dedupeGapCards, GAP_CARD_STATE,
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

  test('content-garbage (contentTier: invalid) is terminal, not merely "not eligible"', () => {
    // classifySilentGap itself never treats an 'invalid' stub as a
    // recoverable empty-body gap (re-ingesting the same URL can only
    // re-fetch garbage) — a stale card for a file later reclassified this
    // way must still close, not sit open forever as an unlabeled null.
    const file = { url: 'https://www.wsj.com/x', contentTier: 'invalid', fullText: '' };
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: false, now: NOW }),
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

describe('dedupe key: within-run identity (#1114 dup of #1070, #1179 dup of #1082)', () => {
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
});

describe('otherAlertPathKey: cross-path duplicate prevention (#1070/#1114, #1082/#1179)', () => {
  // #1070/#1114 and #1082/#1179 were each filed once via the near-opening
  // 'gap:' alert path and once via the >24h 'backstop:' path for the
  // IDENTICAL file, on different runs — same-run dedupe (dedupeGapCards)
  // can't catch that. audit-t1-silent-gaps.js checks otherAlertPathKey()
  // against the alert-router ledger before dispatching down either path;
  // these tests pin the key format that check depends on. Deliberately NOT
  // the same string as gapCardKey() — see gapCardKey's header for why the
  // native, unmigrated 'gap:'/'backstop:' prefixes must stay exactly as
  // every already-open Linear card has them embedded.
  test('from the urgent path, the other key is the backstop-prefixed native key', () => {
    assert.equal(
      otherAlertPathKey('now-you-see-me-live-west-end-2026', 'the-stage--unknown.json', 'gap'),
      'backstop:now-you-see-me-live-west-end-2026/the-stage--unknown.json'
    );
  });

  test('from the backstop path, the other key is the gap-prefixed native key', () => {
    assert.equal(
      otherAlertPathKey('now-you-see-me-live-west-end-2026', 'the-stage--unknown.json', 'backstop'),
      'gap:now-you-see-me-live-west-end-2026/the-stage--unknown.json'
    );
  });
});

describe('dedupeGapCards: one card per show+outlet per run', () => {
  test('two files for the same show+outlet collapse to one primary + one duplicate', () => {
    const gaps = [
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--unknown.json', url: 'https://x/1', type: 'empty-body' },
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--jane-doe.json', url: 'https://x/2', type: 'unscored' },
    ];
    const { primary, duplicates } = dedupeGapCards(gaps);
    assert.equal(primary.length, 1);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].cardState, GAP_CARD_STATE.DUPLICATE);
    assert.equal(duplicates[0].duplicateOfFile, primary[0].file);
  });

  test('a URL-bearing (actionable) candidate always wins over a URL-less one, regardless of scan order', () => {
    // The URL-less file happens to sort first alphabetically AND appears
    // first in the input array — without the URL preference it would
    // silently become primary, leaving the directly-fixable sibling dropped.
    const gaps = [
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--aaa-no-url.json', url: null },
      { showId: 'now-you-see-me-live-west-end-2026', outletId: 'the-stage', file: 'the-stage--zzz-has-url.json', url: 'https://www.thestage.co.uk/reviews/x' },
    ];
    const { primary, duplicates } = dedupeGapCards(gaps);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].file, 'the-stage--zzz-has-url.json');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].file, 'the-stage--aaa-no-url.json');
    assert.equal(duplicates[0].duplicateOfFile, 'the-stage--zzz-has-url.json');
  });

  test('primary selection is deterministic (filename tiebreak) when neither/both candidates have a URL', () => {
    const withoutUrls = [
      { showId: 's', outletId: 'o', file: 'o--zzz.json' },
      { showId: 's', outletId: 'o', file: 'o--aaa.json' },
    ];
    assert.equal(dedupeGapCards(withoutUrls).primary[0].file, 'o--aaa.json');

    const bothWithUrls = [
      { showId: 's', outletId: 'o', file: 'o--zzz.json', url: 'https://x/1' },
      { showId: 's', outletId: 'o', file: 'o--aaa.json', url: 'https://x/2' },
    ];
    assert.equal(dedupeGapCards(bothWithUrls).primary[0].file, 'o--aaa.json');
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
