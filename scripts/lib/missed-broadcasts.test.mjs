import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findMissedBroadcasts,
  classifyBroadcastState,
  wasCoveredByWeeklyRoundup,
  daysSinceOpening,
  hasCompletedBroadcast,
  DEFAULT_MAX_ALERT_AGE_DAYS,
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

// West End floor is 12 (broadcast-readiness.js WEST_END_MIN).
const reviewsFor = (id, n) =>
  Array.from({ length: n }, (_, i) => ({ showId: id, assignedScore: 50 + (i % 40) }));

const find = (over = {}) =>
  findMissedBroadcasts({ shows: [show()], sentShows: {}, reviews: reviewsFor('x-2026', 20), now: NOW, ...over });

test('daysSinceOpening is TZ-independent (bare YYYY-MM-DD parsed as UTC)', () => {
  // The workflow's inline blocks do `new Date(str)` (UTC) then `.setHours(0,0,0,0)`
  // (local) — that pairing shifts a day west of Greenwich. This must not.
  assert.strictEqual(daysSinceOpening('2026-09-01', NOW), 6);
  assert.strictEqual(daysSinceOpening('2026-09-07', NOW), 0);
  assert.strictEqual(daysSinceOpening(null, NOW), null);
  assert.strictEqual(daysSinceOpening('not-a-date', NOW), null);
});

test('flags a qualifying show the pipeline silently dropped', () => {
  const missed = find();
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].id, 'x-2026');
  assert.strictEqual(missed[0].state, 'never-drafted');
  assert.strictEqual(missed[0].alertable, true);
});

test('does NOT flag while the broadcast window is still live', () => {
  assert.deepStrictEqual(find({ shows: [show({ openingDate: '2026-09-06' })] }), []);
});

// --- state classification: the three causes are NOT interchangeable ---

test('classify: a confirmed send is resolved', () => {
  assert.strictEqual(classifyBroadcastState({ completed: true, draftStatus: 'sent', draftId: 'a' }), 'sent');
  assert.strictEqual(hasCompletedBroadcast({ 'x-2026': { completed: true, draftStatus: 'sent', draftId: 'a' } }, 'x-2026'), true);
});

test('classify: legacy pre-schema record counts as sent (no re-page)', () => {
  assert.strictEqual(classifyBroadcastState({ completed: true, draftId: 'legacy' }), 'sent');
  assert.strictEqual(classifyBroadcastState({ completed: true }), 'sent');
});

test('classify: draft created but never sent is draft-stuck, NOT sent', () => {
  // The real shape of to-kill-a-mockingbird-west-end-2026 on 2026-09-07:
  // completed:true is written at DRAFT CREATION, so trusting `completed` alone
  // reports "all good" for a show whose subscribers got nothing.
  const record = { completed: true, draftStatus: 'draft', sentAt: null, draftId: 'abc' };
  assert.strictEqual(classifyBroadcastState(record), 'draft-stuck');
  assert.strictEqual(hasCompletedBroadcast({ 'x-2026': record }, 'x-2026'), false);

  const missed = find({ sentShows: { 'x-2026': record } });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].state, 'draft-stuck');
});

test('classify: a 404 with no observed send is ambiguous, never assumed unsent', () => {
  // Resend reaps SENT broadcasts within hours, so this may already have gone
  // out. Must never be reported in a way that invites a blind re-send.
  assert.strictEqual(classifyBroadcastState({ completed: false, draftStatus: 'deleted', draftId: 'abc' }), 'draft-unknown');
  // ...but a 404 on a record already observed sent IS sent (broadcast-state.js
  // preserves completed only in that case).
  assert.strictEqual(classifyBroadcastState({ completed: true, draftStatus: 'deleted', draftId: 'abc' }), 'sent');
});

test('classify: a cancelled draft is safe to re-send (mirrors shouldRequeueShow)', () => {
  assert.strictEqual(classifyBroadcastState({ completed: false, draftStatus: 'cancelled', draftId: 'abc' }), 'never-drafted');
});

test('an owner preview alone does NOT count as a send', () => {
  // the-story-west-end-2026's real shape: preview delivered to the owner,
  // draft never created, subscribers got nothing.
  const sentShows = {
    'preview:west-end:x-2026:2026-09-05': { sentAt: '2026-09-05T23:24:28.018Z', draftStatus: 'draft' },
  };
  const missed = find({ sentShows });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].state, 'never-drafted');
});

// --- readiness must be the REAL gate, not a copy ---

test('uses the real readiness gate: West End floor is 12', () => {
  assert.deepStrictEqual(find({ reviews: reviewsFor('x-2026', 11) }), []);
  assert.strictEqual(find({ reviews: reviewsFor('x-2026', 12) }).length, 1);
});

test('uses the real readiness gate: Broadway needs 15 AND an aggregator', () => {
  const bway = show({ id: 'b-2026', category: 'broadway' });
  const plain = reviewsFor('b-2026', 20);
  // 20 scored reviews but no DTLI/BWW aggregator — never qualified, so
  // reporting it as a missed send would be a confident lie.
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [bway], sentShows: {}, reviews: plain, now: NOW }),
    []
  );
  // Same show with an aggregator does qualify.
  const withAgg = plain.map((r, i) => (i === 0 ? { ...r, dtliThumb: 'up' } : r));
  assert.strictEqual(
    findMissedBroadcasts({ shows: [bway], sentShows: {}, reviews: withAgg, now: NOW }).length,
    1
  );
  // ...but 14 reviews + aggregator is still under the Broadway floor of 15.
  const under = reviewsFor('b-2026', 14).map((r, i) => (i === 0 ? { ...r, dtliThumb: 'up' } : r));
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [bway], sentShows: {}, reviews: under, now: NOW }),
    []
  );
});

// --- scope guards ---

test('ignores shows that opened before the broadcast pipeline existed', () => {
  // Otherwise the report buries real findings under the whole back catalogue —
  // Phantom (1986) never had an opening-night email and never will.
  const old = show({ id: 'phantom-1986', openingDate: '1986-10-09' });
  assert.deepStrictEqual(
    findMissedBroadcasts({ shows: [old], sentShows: {}, reviews: reviewsFor('phantom-1986', 20), now: NOW }),
    []
  );
});

test('does NOT flag non-broadcast categories, non-open status, opera, or missing dates', () => {
  for (const over of [
    { category: 'off-broadway' },
    { category: 'off-west-end' },
    { category: undefined },
    { status: 'upcoming' },
    { status: 'closed' },
    { type: 'opera' },
    { openingDate: undefined },
  ]) {
    assert.deepStrictEqual(find({ shows: [show(over)] }), [], `should not flag: ${JSON.stringify(over)}`);
  }
});

// --- alerting vs reporting bounds ---

test('past the alert bound a show stays REPORTED but stops paging', () => {
  // Bounding the report itself would recreate the original bug at a longer
  // horizon: the show would vanish, still never sent, with nobody told.
  const aged = show({ openingDate: '2026-08-01' }); // 37d — past the 21d alert bound
  const missed = find({ shows: [aged] });
  assert.strictEqual(missed.length, 1, 'still reported');
  assert.strictEqual(missed[0].alertable, false, 'but not alertable');
  assert.ok(missed[0].daysSinceOpening > DEFAULT_MAX_ALERT_AGE_DAYS);
});

test('drops out of the report entirely past the retention bound', () => {
  const ancient = show({ openingDate: '2026-04-01' }); // 159d, past 90d retention
  assert.deepStrictEqual(find({ shows: [ancient] }), []);
});

test('sorts oldest-opening first so the most-overdue show leads', () => {
  const a = show({ id: 'a-2026', openingDate: '2026-09-03' });
  const b = show({ id: 'b-2026', openingDate: '2026-08-30' });
  const missed = findMissedBroadcasts({
    shows: [a, b],
    sentShows: {},
    reviews: [...reviewsFor('a-2026', 20), ...reviewsFor('b-2026', 20)],
    now: NOW,
  });
  assert.deepStrictEqual(missed.map((m) => m.id), ['b-2026', 'a-2026']);
});

test('regression: electra-persona-west-end-2026 as it actually was on 2026-09-07', () => {
  const missed = findMissedBroadcasts({
    shows: [{
      id: 'electra-persona-west-end-2026',
      title: 'Electra / Persona',
      status: 'open',
      category: 'west-end',
      openingDate: '2026-09-01',
    }],
    sentShows: {},
    reviews: reviewsFor('electra-persona-west-end-2026', 32),
    now: NOW,
  });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].title, 'Electra / Persona');
  assert.strictEqual(missed[0].daysSinceOpening, 6);
  assert.strictEqual(missed[0].state, 'never-drafted');
  assert.strictEqual(missed[0].alertable, true);
});

// --- BRO-3088: West End Weekly Round-up suppression ---

test('wasCoveredByWeeklyRoundup: true when featured in any issue, regardless of edition tag', () => {
  // generate.mjs runs a West End openings section in BOTH editions (primary in
  // 'west-end', secondary in 'broadway') — a 'broadway'-tagged issue can and
  // does carry full West End cards, so the edition tag must not gate this.
  assert.strictEqual(
    wasCoveredByWeeklyRoundup([{ weekStart: '2026-08-31', edition: 'broadway', featuredShowIds: ['electra-persona-west-end-2026'] }], 'electra-persona-west-end-2026'),
    true
  );
  assert.strictEqual(wasCoveredByWeeklyRoundup([{ weekStart: '2026-08-31', featuredShowIds: [] }], 'electra-persona-west-end-2026'), false);
  assert.strictEqual(wasCoveredByWeeklyRoundup([], 'electra-persona-west-end-2026'), false);
  assert.strictEqual(wasCoveredByWeeklyRoundup(null, 'electra-persona-west-end-2026'), false);
  assert.strictEqual(wasCoveredByWeeklyRoundup([{ featuredShowIds: ['x'] }], null), false);
});

test('regression: BRO-3088 — a West End show already in the Round-up does not page as missed', () => {
  // The real shape on 2026-09-07: electra-persona-west-end-2026, the-story-west-end-2026,
  // and abigails-party-west-end-2026 all paged "Opening Night Email Never Reached
  // Subscribers" despite the 2026-08-31 Round-up draft already carrying full cards
  // for all three — a redundant force_broadcast ask the owner declined.
  const newsletterIssues = [
    { weekStart: '2026-08-31', edition: 'broadway', featuredShowIds: ['electra-persona-west-end-2026', 'the-story-west-end-2026', 'a-month-in-the-country-west-end-2026'] },
  ];
  const shows = [
    show({ id: 'electra-persona-west-end-2026', openingDate: '2026-09-01' }),
    show({ id: 'the-story-west-end-2026', openingDate: '2026-09-01' }),
  ];
  const reviews = [...reviewsFor('electra-persona-west-end-2026', 20), ...reviewsFor('the-story-west-end-2026', 20)];

  const withoutRoundup = findMissedBroadcasts({ shows, sentShows: {}, reviews, now: NOW });
  assert.strictEqual(withoutRoundup.every((m) => m.alertable), true, 'sanity: pages without the round-up signal');

  const missed = findMissedBroadcasts({ shows, sentShows: {}, reviews, now: NOW, newsletterIssues });
  assert.strictEqual(missed.length, 2, 'still reported, not silently dropped');
  for (const m of missed) {
    assert.strictEqual(m.state, 'covered-by-roundup');
    assert.strictEqual(m.alertable, false, 'no page for round-up-covered West End shows');
  }
});

test('round-up coverage does not suppress Broadway (no equivalent weekly digest)', () => {
  const bway = show({ id: 'b-2026', category: 'broadway' });
  const withAgg = reviewsFor('b-2026', 20).map((r, i) => (i === 0 ? { ...r, dtliThumb: 'up' } : r));
  const newsletterIssues = [{ weekStart: '2026-08-31', featuredShowIds: ['b-2026'] }];
  const missed = findMissedBroadcasts({ shows: [bway], sentShows: {}, reviews: withAgg, now: NOW, newsletterIssues });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].state, 'never-drafted');
  assert.strictEqual(missed[0].alertable, true);
});

test('round-up coverage does not mask a genuinely stuck draft (draft-stuck still pages)', () => {
  // A West End show can be both round-up-covered AND have a stray Resend draft
  // sitting unsent — that draft still needs a human, so coverage must not
  // paper over a state other than never-drafted.
  const record = { completed: true, draftStatus: 'draft', sentAt: null, draftId: 'abc' };
  const newsletterIssues = [{ weekStart: '2026-08-31', featuredShowIds: ['x-2026'] }];
  const missed = find({ sentShows: { 'x-2026': record }, newsletterIssues });
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].state, 'draft-stuck');
  assert.strictEqual(missed[0].alertable, true);
});
