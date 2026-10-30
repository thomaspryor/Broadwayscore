import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recheckCandidates, qualFlags, pushCandidates, feedFacts, feedIsFresh, findDispatchedRun, runOutcome, runNameFor } = require('./reviews-in-push.js');

const NOW = Date.parse('2026-10-26T15:00:00Z');
const shows = [
  { id: 'a-2026', slug: 'a', title: 'A', category: 'broadway', openingDate: '2026-10-25' },
  { id: 'b-2026', slug: 'b', title: "Hell's Kitchen", openingDate: '2026-10-24' },
  { id: 'c-2026', slug: 'c', title: 'C', category: 'west-end', openingDate: '2026-10-25' },
  { id: 'd-2026', slug: 'd', title: 'D', category: 'off-broadway', openingDate: '2026-10-25' },
  { id: 'e-2025', slug: 'e', title: 'E', category: 'broadway', openingDate: '2026-09-01' },
  { id: 'f-2026', slug: 'f', title: 'F', category: 'broadway' },
];

test('pushCandidates: Broadway and West End, recent, not yet marked; carries id AND slug', () => {
  const r = pushCandidates({ readyIds: shows.map(s => s.id), shows, sent: { 'push:a-2026': { sentAt: 'x' } }, now: NOW });
  assert.deepEqual(r, [
    { id: 'b-2026', slug: 'b', title: "Hell's Kitchen", category: 'broadway' },
    { id: 'c-2026', slug: 'c', title: 'C', category: 'west-end' },
  ]);
});

test('pushCandidates: West End shows are included (the old loop covered Broadway only)', () => {
  const r = pushCandidates({ readyIds: ['c-2026'], shows, sent: {}, now: NOW });
  assert.equal(r[0].category, 'west-end');
});

test('pushCandidates: an old show never gets a late push; a show with no opening date is skipped', () => {
  assert.deepEqual(pushCandidates({ readyIds: ['e-2025', 'f-2026'], shows, sent: {}, now: NOW }), []);
});

test('pushCandidates: an openingDate with a time part still counts', () => {
  const stamped = [{ id: 'g-2026', slug: 'g', title: 'G', category: 'broadway', openingDate: '2026-10-25T00:00:00.000Z' }];
  assert.equal(pushCandidates({ readyIds: ['g-2026'], shows: stamped, sent: {}, now: NOW }).length, 1);
});

test('pushCandidates: ids not in shows.json are ignored', () => {
  assert.deepEqual(pushCandidates({ readyIds: ['nope'], shows, sent: {}, now: NOW }), []);
});

const run = (o) => ({ displayTitle: runNameFor('a-2026'), createdAt: '2026-10-26T15:00:30Z', status: 'completed', conclusion: 'success', ...o });

test('findDispatchedRun: matches by run name and dispatch time, newest first', () => {
  const at = Date.parse('2026-10-26T15:00:00Z');
  const runs = [
    run({ createdAt: '2026-10-25T10:00:00Z', conclusion: 'failure' }),
    run({ displayTitle: runNameFor('b-2026') }),
    run({ createdAt: '2026-10-26T15:00:20Z' }),
    run({ createdAt: '2026-10-26T15:00:40Z', conclusion: 'failure' }),
  ];
  assert.equal(findDispatchedRun(runs, 'a-2026', at).createdAt, '2026-10-26T15:00:40Z');
  assert.equal(findDispatchedRun(runs, 'zzz', at), null);
  assert.equal(findDispatchedRun([run({ createdAt: '2026-10-26T14:00:00Z' })], 'a-2026', at), null);
});

test('runOutcome: only a successful finished run counts as sent', () => {
  assert.equal(runOutcome(null), 'pending');
  assert.equal(runOutcome(run({ status: 'in_progress', conclusion: null })), 'pending');
  assert.equal(runOutcome(run({})), 'sent');
  assert.equal(runOutcome(run({ conclusion: 'failure' })), 'failed');
  assert.equal(runOutcome(run({ conclusion: 'cancelled' })), 'failed');
});

test('feedFacts: a displayable score, its label, the audience grade and the type come through', () => {
  const f = feedFacts({ id: 'x', ty: 'musical', cr: { s: 83.4, l: 'Critical Gold', q: 1 }, ag: { g: 'A+' } });
  assert.deepEqual(f, { criticScore: '83', criticLabel: 'Critical Gold', audienceGrade: 'A+', showType: 'musical' });
});

test('feedFacts: an unqualified score (cr.q 0) is withheld so it never counts toward Gold or 75+', () => {
  const f = feedFacts({ id: 'x', ty: 'play', cr: { s: 91, l: 'Critical Gold', q: 0 }, ag: { g: 'B' } });
  assert.deepEqual(f, { criticScore: '', criticLabel: '', audienceGrade: 'B', showType: 'play' });
});

test('feedFacts: a show missing from the feed, or with no score or grade, gives empty strings (never a guess)', () => {
  const empty = { criticScore: '', criticLabel: '', audienceGrade: '', showType: '' };
  assert.deepEqual(feedFacts(undefined), empty);
  assert.deepEqual(feedFacts({ id: 'y' }), empty);
  assert.deepEqual(feedFacts({ id: 'y', cr: { s: null, q: 1 } }), empty);
});

test('feedIsFresh: only a feed built in the last 3h is trusted for facts', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(feedIsFresh('2026-10-30T10:00:00Z', now), true);
  assert.equal(feedIsFresh('2026-10-30T08:00:00Z', now), false);
  assert.equal(feedIsFresh(undefined, now), false);
  assert.equal(feedIsFresh('garbage', now), false);
});

// BRO-6662: a show pushed once that later qualifies for a threshold mode it missed.
const entry = (o = {}) => ({ id: 'a-2026', ty: 'musical', cr: { s: 82, l: 'Recommended', q: 1 }, ag: { g: 'B+' }, ...o });
const feedOf = (e) => new Map([[e.id, e]]);
const pushed = (quals) => ({ 'push:a-2026': { sentAt: 'x' }, 'pushfacts:a-2026': { sentAt: 'x', quals } });
const base = (e, quals) => ({ shows, sent: pushed(quals), feedById: feedOf(e), now: NOW });

test('qualFlags: the four modes, gated like the app (score only when shown)', () => {
  assert.deepEqual(qualFlags(feedFacts(entry())), ['recommended-75', 'new-musical']);
  assert.deepEqual(qualFlags(feedFacts(entry({ cr: { s: 90, l: 'Critical Gold', q: 0 } }))), ['new-musical']);
  assert.deepEqual(qualFlags(feedFacts(entry({ cr: { s: 90, l: 'Critical Gold', q: 1 }, ag: { g: 'A+' } }))),
    ['critical-gold', 'recommended-75', 'audience-a', 'new-musical']);
});

test('recheck: audience grade lands after the push -> one recheck carrying the modes already covered', () => {
  const r = recheckCandidates(base(entry({ ag: { g: 'A' } }), ['recommended-75', 'new-musical']));
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a-2026');
  assert.deepEqual(r[0].gained, ['audience-a']);
  assert.equal(r[0].prior, 'recommended-75,new-musical');
  assert.deepEqual(r[0].quals, ['recommended-75', 'new-musical', 'audience-a']);
});

test('recheck: nothing gained (score drift, same modes, regression) -> no dispatch', () => {
  assert.deepEqual(recheckCandidates(base(entry({ cr: { s: 88, l: 'Recommended', q: 1 } }), ['recommended-75', 'new-musical'])), []);
  assert.deepEqual(recheckCandidates(base(entry({ cr: { s: 60, l: 'Mixed', q: 1 } }), ['recommended-75', 'new-musical'])), []);
});

test('recheck: score qualifies late (first feed had cr.q=0)', () => {
  const r = recheckCandidates(base(entry({ cr: { s: 91, l: 'Critical Gold', q: 1 } }), ['new-musical']));
  assert.deepEqual(r[0].gained, ['critical-gold', 'recommended-75']);
});

test('recheck: no baseline (pushed before this existed), no marker, old, or off-market show -> never', () => {
  const e = entry({ ag: { g: 'A' } });
  assert.deepEqual(recheckCandidates({ shows, sent: { 'push:a-2026': { sentAt: 'x' } }, feedById: feedOf(e), now: NOW }), []);
  assert.deepEqual(recheckCandidates({ shows, sent: { 'pushfacts:a-2026': { quals: [] } }, feedById: feedOf(e), now: NOW }), []);
  assert.deepEqual(recheckCandidates({ ...base(e, []), now: NOW + 10 * 86_400_000 }), []);
  const d = entry({ id: 'd-2026', ag: { g: 'A' } });
  assert.deepEqual(recheckCandidates({ shows, sent: { 'push:d-2026': {}, 'pushfacts:d-2026': { quals: [] } }, feedById: feedOf(d), now: NOW }), []);
  assert.deepEqual(recheckCandidates({ ...base(e, []), feedById: new Map() }), []);
});
