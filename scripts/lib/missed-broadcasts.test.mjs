import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findMissedBroadcasts,
  daysSinceOpening,
  hasCompletedBroadcast,
} = require('./missed-broadcasts.js');

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z

const show = (over = {}) => ({
  id: 'x-2026',
  title: 'X',
  status: 'open',
  category: 'west-end',
  openingDate: '2026-09-01',
  ...over,
});

// 12 scored reviews = exactly the floor.
const reviewsFor = (id, n) =>
  Array.from({ length: n }, (_, i) => ({ showId: id, assignedScore: 50 + i }));

test('daysSinceOpening is TZ-independent (bare YYYY-MM-DD parsed as UTC)', () => {
  // The workflow's inline blocks do `new Date(str)` (UTC) then `.setHours(0,0,0,0)`
  // (local) — that pairing shifts a day west of Greenwich. This must not.
  assert.strictEqual(daysSinceOpening('2026-09-01', NOW), 6);
  assert.strictEqual(daysSinceOpening('2026-09-07', NOW), 0);
  assert.strictEqual(daysSinceOpening('2026-09-04', NOW), 3);
  assert.strictEqual(daysSinceOpening(null, NOW), null);
  assert.strictEqual(daysSinceOpening('not-a-date', NOW), null);
});

test('flags a qualifying show the pipeline silently dropped', () => {
  const s = show();
  const missed = findMissedBroadcasts({
    shows: [s],
    sentShows: {},
    reviews: reviewsFor(s.id, 20),
    now: NOW,
  });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].id, 'x-2026');
  assert.strictEqual(missed[0].daysSinceOpening, 6);
  assert.strictEqual(missed[0].scoredReviews, 20);
});

test('does NOT flag while the broadcast window is still live', () => {
  // Opened yesterday: the pipeline is still trying, the overdue pager owns this.
  const s = show({ openingDate: '2026-09-06' });
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [s], sentShows: {}, reviews: reviewsFor(s.id, 20), now: NOW }),
    []
  );
});

test('does NOT flag once a broadcast completed', () => {
  const s = show();
  const sentShows = { 'x-2026': { completed: true, draftStatus: 'sent', draftId: 'abc' } };
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [s], sentShows, reviews: reviewsFor(s.id, 20), now: NOW }),
    []
  );
});

test('legacy pre-schema sent record counts as completed (no re-page)', () => {
  const s = show();
  // No draftStatus — migrateSentRecord must read this as sent.
  const sentShows = { 'x-2026': { completed: true, draftId: 'legacy' } };
  assert.strictEqual(hasCompletedBroadcast(sentShows, 'x-2026'), true);
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [s], sentShows, reviews: reviewsFor(s.id, 20), now: NOW }),
    []
  );
});

test('an owner preview alone does NOT count as a completed broadcast', () => {
  // the-story-west-end-2026's real shape on 2026-09-07: preview sent, no draft.
  const s = show();
  const sentShows = {
    'preview:west-end:x-2026:2026-09-05': { sentAt: '2026-09-05T23:24:28.018Z', draftStatus: 'draft' },
  };
  const missed = findMissedBroadcasts({
    shows: [s],
    sentShows,
    reviews: reviewsFor(s.id, 20),
    now: NOW,
  });
  assert.strictEqual(missed.length, 1, 'preview-only is the half-finished state this sweep exists to catch');
});

test('does NOT flag below the scored-review floor (sparse coverage is not a failure)', () => {
  const s = show();
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [s], sentShows: {}, reviews: reviewsFor(s.id, 11), now: NOW }),
    []
  );
  assert.strictEqual(
    findMissedBroadcasts({ shows: [s], sentShows: {}, reviews: reviewsFor(s.id, 12), now: NOW }).length,
    1,
    '12 is the floor, inclusive'
  );
});

test('does NOT flag non-broadcast categories, non-open status, opera, or missing dates', () => {
  const cases = [
    show({ category: 'off-broadway' }),
    show({ category: 'off-west-end' }),
    show({ category: undefined }),
    show({ status: 'upcoming' }),
    show({ status: 'closed' }),
    show({ type: 'opera' }),
    show({ openingDate: undefined }),
  ];
  for (const s of cases) {
    assert.deepStrictEqual(
      findMissedBroadcasts({ shows: [s], sentShows: {}, reviews: reviewsFor(s.id, 20), now: NOW }),
      [],
      `should not flag: ${JSON.stringify({ c: s.category, st: s.status, t: s.type, d: s.openingDate })}`
    );
  }
});

test('stops flagging past the max age (bounded, so first run cannot page the back catalogue)', () => {
  const inRange = show({ id: 'in-2026', openingDate: '2026-08-18' }); // 20d
  const tooOld = show({ id: 'old-2026', openingDate: '2026-08-16' }); // 22d
  const missed = findMissedBroadcasts({
    shows: [inRange, tooOld],
    sentShows: {},
    reviews: [...reviewsFor('in-2026', 20), ...reviewsFor('old-2026', 20)],
    now: NOW,
  });
  assert.deepStrictEqual(missed.map((m) => m.id), ['in-2026']);
});

test('sorts oldest-opening first so the most-overdue show leads the alert', () => {
  const a = show({ id: 'a-2026', openingDate: '2026-09-03' }); // 4d
  const b = show({ id: 'b-2026', openingDate: '2026-08-30' }); // 8d
  const missed = findMissedBroadcasts({
    shows: [a, b],
    sentShows: {},
    reviews: [...reviewsFor('a-2026', 20), ...reviewsFor('b-2026', 20)],
    now: NOW,
  });
  assert.deepStrictEqual(missed.map((m) => m.id), ['b-2026', 'a-2026']);
});

test('reviews without an assignedScore do not count toward the floor', () => {
  const s = show();
  const reviews = [
    ...reviewsFor(s.id, 11),
    { showId: s.id, assignedScore: null },
    { showId: s.id },
    { showId: 'other-2026', assignedScore: 90 },
  ];
  assert.deepStrictEqual(findMissedBroadcasts({ shows: [s], sentShows: {}, reviews, now: NOW }), []);
});

test('regression: electra-persona-west-end-2026 as it actually was on 2026-09-07', () => {
  // The incident. Opened 09-01, 32 scored reviews, zero entries in
  // opening-night-sent.json, checklist-blocked until it left the window.
  const missed = findMissedBroadcasts({
    shows: [
      {
        id: 'electra-persona-west-end-2026',
        title: 'Electra / Persona',
        status: 'open',
        category: 'west-end',
        openingDate: '2026-09-01',
      },
    ],
    sentShows: {},
    reviews: reviewsFor('electra-persona-west-end-2026', 32),
    now: NOW,
  });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].title, 'Electra / Persona');
  assert.strictEqual(missed[0].daysSinceOpening, 6);
});
