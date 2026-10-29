// BRO-6542: new tour / pre-Broadway / UK regional shows in the morning digest,
// plus suggested Reddit posts for the new pre-Broadway ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./new-show-types.js');
const { buildHtml } = require('../send-morning-digest.js');

const NOW = new Date('2026-10-29T08:00:00Z');

function show(over = {}) {
  return {
    id: 'rhinoceros-regional-2026', slug: 'rhinoceros-regional-2026', title: 'Rhinoceros',
    category: 'regional', status: 'open', venue: 'American Repertory Theater, Cambridge, MA',
    openingDate: '2026-08-21', closingDate: null, synopsis: 'An ordinary town turns strange. Friends become rhinoceroses.',
    ...over,
  };
}
const slim = { rc: 11, cs: 88.4 };
const noDashes = s => assert.ok(!/[—–]/.test(s), `dash in: ${s.slice(0, 120)}`);

test('kindOf splits tour, pre-Broadway (US regional) and UK regional, and skips the rest', () => {
  assert.equal(lib.kindOf(show({ category: 'tour', venue: 'North American Tour' })), 'tour');
  assert.equal(lib.kindOf(show()), 'pre-broadway');
  assert.equal(lib.kindOf(show({ venue: 'Royal Exchange Theatre, Manchester' })), 'regional');
  assert.equal(lib.kindOf(show({ venue: 'Sheffield Crucible' })), 'regional', 'venue alias counts');
  assert.equal(lib.kindOf(show({ localOnly: true })), null, 'Chicago local listings are withheld on the site');
  assert.equal(lib.kindOf(show({ category: 'broadway' })), null);
  assert.equal(lib.kindOf(null), null);
});

test('diffAgainstLedger: first run seeds the back catalogue silently, keeps recent discoveries', () => {
  const old = show({ id: 'old', discoveredAt: '2026-06-01T00:00:00Z' });
  const recent = show({ id: 'recent', discoveredAt: '2026-10-27T00:00:00Z' });
  const undated = show({ id: 'undated' });
  const other = show({ id: 'bway', category: 'broadway' });
  const r = lib.diffAgainstLedger([old, recent, undated, other], null, NOW);
  assert.deepEqual(r.fresh.map(s => s.id), ['recent']);
  assert.equal(r.ledger.seen.old, 'seeded');
  assert.equal(r.ledger.seen.undated, 'seeded');
  assert.equal(r.ledger.seen.recent, NOW.toISOString());
  assert.ok(!('bway' in r.ledger.seen), 'other categories never enter the ledger');
});

test('diffAgainstLedger: later runs flag only unseen shows and never drop ledger entries', () => {
  const ledger = { seen: { a: 'seeded', gone: '2026-10-01T00:00:00Z' } };
  const r = lib.diffAgainstLedger([show({ id: 'a' }), show({ id: 'b' })], ledger, NOW);
  assert.deepEqual(r.fresh.map(s => s.id), ['b']);
  assert.equal(r.ledger.seen.gone, '2026-10-01T00:00:00Z');
  assert.equal(lib.diffAgainstLedger([show({ id: 'a' }), show({ id: 'b' })], r.ledger, NOW).fresh.length, 0);
});

test('diffAgainstLedger: closed runs are recorded but never announced', () => {
  const ledger = { seen: { a: 'seeded' } };
  const r = lib.diffAgainstLedger([show({ id: 'old-tour', status: 'closed', category: 'tour' }), show({ id: 'live' })], ledger, NOW);
  assert.deepEqual(r.fresh.map(s => s.id), ['live']);
  assert.equal(r.ledger.seen['old-tour'], 'seeded');
});

test('recentlySeen keeps the 48h window, newest first, and ignores seeded rows', () => {
  const ledger = { seen: { a: '2026-10-29T02:00:00Z', b: '2026-10-28T02:00:00Z', c: '2026-10-26T02:00:00Z', d: 'seeded' } };
  const shows = ['a', 'b', 'c', 'd'].map(id => show({ id }));
  assert.deepEqual(lib.recentlySeen(shows, ledger, NOW).map(s => s.id), ['a', 'b']);
});

test('Reddit suggestion: pre-Broadway only, open runs only, facts from the show and slim file', () => {
  const r = lib.buildRedditSuggestion(show(), slim, { today: '2026-10-29' });
  assert.equal(r.subreddit, 'Broadway');
  assert.match(r.title, /^Rhinoceros at American Repertory Theater in Cambridge, MA: 88\/100 from 11 critics so far\./);
  assert.match(r.body, /It opened on August 21\./);
  assert.match(r.body, /Friends become rhinoceroses\.|An ordinary town turns strange\./);
  assert.match(r.body, /https:\/\/broadwayscorecard\.com\/show\/rhinoceros-regional-2026$/);
  assert.match(r.note, /Broadway/);
  const q = new URL(r.url);
  assert.equal(q.pathname, '/r/Broadway/submit');
  assert.equal(q.searchParams.get('title'), r.title);
  assert.equal(q.searchParams.get('text'), r.body);
  noDashes(r.title); noDashes(r.body);

  assert.equal(lib.buildRedditSuggestion(show({ status: 'closed' }), slim), null, 'closed run: no post');
  assert.equal(lib.buildRedditSuggestion(show({ category: 'tour' }), slim), null);
  assert.equal(lib.buildRedditSuggestion(show({ venue: 'Chichester Festival Theatre' }), slim), null, 'UK regional is not pre-Broadway');
});

test('Reddit suggestion: a score needs 5+ reviews; thin shows with no facts get no draft', () => {
  const few = lib.buildRedditSuggestion(show(), { rc: 3, cs: 90 }, { today: '2026-10-29' });
  assert.doesNotMatch(few.title, /\/100/);
  assert.match(few.title, /Rhinoceros is playing at American Repertory Theater/);
  const thin = show({ synopsis: '', openingDate: null, closingDate: null, status: 'upcoming' });
  assert.equal(lib.buildRedditSuggestion(thin, null), null);
  const previews = lib.buildRedditSuggestion(show({ status: 'previews', synopsis: '', openingDate: '2026-11-05' }), null, { today: '2026-10-29' });
  assert.match(previews.body, /^It is in previews and opens on November 5\./);
});

test('Reddit suggestion: previews with a past opening date do not claim it is still to come', () => {
  const r = lib.buildRedditSuggestion(show({ status: 'previews', synopsis: 'A quiet play.', openingDate: '2026-10-01' }), null, { today: '2026-10-29' });
  assert.doesNotMatch(r.body, /opens on/);
  assert.match(r.body, /^It is in previews\./);
});

test('Reddit suggestion strips dashes that arrive in show data', () => {
  const r = lib.buildRedditSuggestion(show({ title: 'Rhino — Live', synopsis: 'A town — and its rhinos.' }), slim, { today: '2026-10-29' });
  noDashes(r.title); noDashes(r.body);
});

test('UK regional links go to the West End site', () => {
  assert.equal(lib.urlFor(show({ venue: 'Royal Exchange Theatre, Manchester' })), 'https://westendscorecard.com/show/rhinoceros-regional-2026');
  assert.equal(lib.urlFor(show()), 'https://broadwayscorecard.com/show/rhinoceros-regional-2026');
});

function populated() {
  const shows = [
    show({ id: 'uk', title: 'King Lear', venue: 'Royal Exchange Theatre, Manchester' }),
    show({ id: 'tour1', title: 'Beetlejuice', category: 'tour', venue: 'North American Tour', openingDate: '2026-02-13' }),
    show({ id: 'pb1', title: 'Rhinoceros' }),
    show({ id: 'pb2', title: 'Topdog/Underdog' }),
    show({ id: 'pb3', title: 'Third' }),
    show({ id: 'pb4', title: 'Fourth' }),
    show({ id: 'pb5', title: 'Fifth' }),
  ];
  const seen = {};
  shows.forEach((s, i) => { seen[s.id] = `2026-10-29T0${i}:00:00Z`; });
  return { shows, ledger: { seen } };
}

test('buildSnapshot lists pre-Broadway first, caps drafts at 3 and rows at 8, and counts the rest', () => {
  const { shows, ledger } = populated();
  const slims = new Map(shows.map(s => [s.id, slim]));
  const snap = lib.buildSnapshot({ shows, ledger, slims, now: NOW });
  assert.deepEqual(snap.items.map(i => i.kind), ['pre-broadway', 'pre-broadway', 'pre-broadway', 'pre-broadway', 'pre-broadway', 'tour', 'regional']);
  assert.equal(snap.items.filter(i => i.reddit).length, lib.MAX_REDDIT_DRAFTS);
  assert.equal(snap.bannerText, '7 new: 5 Pre-Broadway, 1 Tour, 1 UK regional');
  assert.equal(snap.moreCount, 0);

  const many = Array.from({ length: 12 }, (_, i) => show({ id: `t${i}`, title: `Tour ${i}`, category: 'tour', venue: 'US Tour' }));
  const seen = Object.fromEntries(many.map(s => [s.id, '2026-10-29T02:00:00Z']));
  const big = lib.buildSnapshot({ shows: many, ledger: { seen }, now: NOW });
  assert.equal(big.items.length, lib.MAX_ITEMS);
  assert.equal(big.moreCount, 4);
});

test('buildSnapshot on a quiet day is a valid, fresh, empty snapshot', () => {
  const snap = lib.buildSnapshot({ shows: [show()], ledger: { seen: { 'rhinoceros-regional-2026': 'seeded' } }, now: NOW });
  assert.deepEqual(snap.items, []);
  assert.equal(snap.generatedAt, NOW.toISOString());
  assert.equal(lib.renderNewShowTypesBlock(snap, { now: NOW }), '');
});

test('renderNewShowTypesBlock: rows, Reddit box with the Reddit link, escaping, no dashes', () => {
  const { shows, ledger } = populated();
  const snap = lib.buildSnapshot({ shows, ledger, slims: new Map([['pb1', slim]]), now: NOW });
  snap.items[0].title = 'Rhino <script>alert(1)</script>';
  const html = lib.renderNewShowTypesBlock(snap, { now: NOW });
  assert.match(html, /New tour, pre-Broadway and UK regional shows/);
  assert.match(html, /Suggested post for r\/Broadway/);
  assert.match(html, /https:\/\/www\.reddit\.com\/r\/Broadway\/submit\?/);
  assert.match(html, /Beetlejuice/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /added overnight/);
  noDashes(html);
  const yesterday = lib.renderNewShowTypesBlock({ items: [{ title: 'X', firstSeen: '2026-10-28T02:00:00Z' }], moreCount: 2 }, { now: NOW });
  assert.match(yesterday, /added yesterday/);
  assert.match(yesterday, /Plus 2 more/);
});

test('the morning email shows the block above the technical report, and omits it on a quiet day', () => {
  const { shows, ledger } = populated();
  const snap = lib.buildSnapshot({ shows, ledger, slims: new Map([['pb1', slim]]), now: NOW });
  const html = buildHtml({ sections: { newShowTypes: snap }, now: NOW });
  const at = html.indexOf('New tour, pre-Broadway and UK regional shows');
  assert.ok(at > 0, 'block is in the email');
  const tech = html.indexOf('Technical details');
  assert.ok(tech === -1 || at < tech, 'block sits above Technical details');
  const quiet = buildHtml({ sections: { newShowTypes: { generatedAt: NOW.toISOString(), items: [], moreCount: 0 } }, now: NOW });
  assert.equal(quiet, buildHtml({ sections: {}, now: NOW }));
});
