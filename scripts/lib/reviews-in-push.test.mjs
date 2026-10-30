import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pushCandidates, feedFacts, feedIsFresh, findDispatchedRun, runOutcome, runNameFor } = require('./reviews-in-push.js');

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
