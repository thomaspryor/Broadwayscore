// BRO-8087: the owner's pacing rule for paid test-bench redos (3 a day, never within 24 h of an opening, $50 stop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { paceCheck, nextEligible, openingInstants, redoSpend, ledgerReading } = require('./test-bench-redo-pace.js');

const H = 3600 * 1000;
const at = (s) => Date.parse(s);
const row = (startedAt, total = 3) => ({ show: 'x', startedAt, spendUsd: { total } });

test('refuses a run within 24 h of an opening embargo, either side', () => {
  const openings = [{ id: 'samson', category: 'off-broadway', at: at('2026-11-28T02:00:00Z') }];
  const before = paceCheck({ openings, atMs: at('2026-11-27T10:30:00Z'), windowMin: 120 });
  assert.equal(before.ok, false);
  assert.match(before.reasons[0], /samson/);
  const after = paceCheck({ openings, atMs: at('2026-11-28T20:00:00Z'), windowMin: 120 });
  assert.equal(after.ok, false);
  const clear = paceCheck({ openings, atMs: at('2026-11-29T02:30:00Z'), windowMin: 120 });
  assert.equal(clear.ok, true);
});

test('the run window counts, not only its start', () => {
  const openings = [{ id: 'o', category: 'broadway', at: at('2026-12-02T02:00:00Z') }];
  // Starts 25 h before the embargo, but a 120-min window + setup ends inside the 24 h band.
  assert.equal(paceCheck({ openings, atMs: at('2026-12-01T01:00:00Z'), windowMin: 120 }).ok, false);
  assert.equal(paceCheck({ openings, atMs: at('2026-11-30T23:00:00Z'), windowMin: 120 }).ok, true);
});

test('at most 3 redos per New York day', () => {
  const rows = [row('2026-11-30T15:00:00Z'), row('2026-11-30T18:00:00Z'), row('2026-11-30T21:00:00Z')];
  const c = paceCheck({ rows, atMs: at('2026-12-01T03:00:00Z') }); // 22:00 ET on 11-30
  assert.equal(c.ok, false);
  assert.match(c.reasons[0], /3 redo/);
  assert.equal(paceCheck({ rows, atMs: at('2026-12-01T06:00:00Z') }).ok, true); // 01:00 ET on 12-01
});

test('$50 stop is never crossed: refuses when total + estimate would pass it', () => {
  const rows = [row('2026-11-01T15:00:00Z', 44), row('2026-11-02T15:00:00Z', 2)];
  assert.equal(ledgerReading(rows, at('2026-11-30T15:00:00Z')).spentUsd, 46);
  const c = paceCheck({ rows, atMs: at('2026-11-30T15:00:00Z') });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(' '), /\$50 stop/);
  assert.equal(nextEligible({ rows, fromMs: at('2026-11-30T15:00:00Z') }), null);
});

test('nextEligible finds the first free 30-min slot after the openings', () => {
  const openings = [
    { id: 'a', category: 'off-broadway', at: at('2026-11-28T02:00:00Z') },
    { id: 'b', category: 'west-end', at: at('2026-11-28T22:00:00Z') },
  ];
  const n = nextEligible({ openings, fromMs: at('2026-11-27T10:27:00Z'), windowMin: 120 });
  assert.equal(n.at, '2026-11-29T22:00:00.000Z');
});

test('openingInstants keeps lane markets + West End, drops closed and other categories', () => {
  const shows = [
    { id: 'b', category: 'broadway', openingDate: '2026-12-01', status: 'previews' },
    { id: 'w', category: 'west-end', openingDate: '2026-12-09' },
    { id: 'r', category: 'regional', openingDate: '2026-12-01' },
    { id: 'c', category: 'off-broadway', openingDate: '2026-12-02', status: 'closed' },
  ];
  const got = openingInstants(shows, { embargoAt: (s) => `${s.openingDate}T23:00:00Z` });
  assert.deepEqual(got.map((x) => x.id), ['b', 'w']);
});

test('redoSpend sums only this show in the run span', () => {
  const spend = [
    { ts: '2026-11-30T23:10:00Z', provider: 'brightdata', showId: 'x' },
    { ts: '2026-11-30T23:11:00Z', provider: 'brightdata', showId: 'x' },
    { ts: '2026-11-30T23:12:00Z', provider: 'browserbase', showId: 'x' },
    { ts: '2026-11-30T23:12:00Z', provider: 'brightdata', showId: 'other' },
    { ts: '2026-12-01T05:00:00Z', provider: 'brightdata', showId: 'x' },
  ];
  const s = redoSpend(spend, { showId: 'x', startMs: at('2026-11-30T23:00:00Z'), endMs: at('2026-12-01T01:00:00Z'), scored: 10 });
  assert.deepEqual(s.calls, { brightdata: 2, browserbase: 1, scrapingbee: 0, scrapingdog: 0 });
  assert.equal(s.total, 0.51);
});

test('a claimed run counts at its estimate until recorded; the record replaces it, not adds to it', () => {
  const claim = { id: 'x@1', show: 'x', startedAt: '2026-11-30T23:00:00Z', status: 'started', spendUsd: { total: 4 } };
  assert.equal(ledgerReading([claim], at('2026-11-30T23:30:00Z')).spentUsd, 4);
  assert.equal(ledgerReading([claim], at('2026-11-30T23:30:00Z')).today, 1);
  const done = { ...claim, status: 'graded', spendUsd: { total: 1.2 } };
  const r = ledgerReading([claim, done], at('2026-11-30T23:30:00Z'));
  assert.equal(r.spentUsd, 1.2);
  assert.equal(r.runs, 1);
});

test('a reordered merge cannot put the claim back over its settlement', () => {
  const claim = { id: 'x@1', show: 'x', startedAt: '2026-11-30T23:00:00Z', status: 'started', spendUsd: { total: 5 } };
  const done = { ...claim, status: 'graded', spendUsd: { total: 8 } };
  assert.equal(ledgerReading([done, claim], at('2026-11-30T23:30:00Z')).spentUsd, 8);
});

test('an open claim refuses the next run and nextEligible does not wait it out', () => {
  const claim = { id: 'x@1', show: 'x', startedAt: '2026-11-30T23:00:00Z', status: 'started', spendUsd: { total: 5 } };
  const c = paceCheck({ rows: [claim], atMs: at('2026-12-01T03:00:00Z') });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(' '), /still open/);
  assert.equal(nextEligible({ rows: [claim], fromMs: at('2026-12-01T03:00:00Z') }), null);
  assert.equal(paceCheck({ rows: [claim, { ...claim, status: 'failed' }], atMs: at('2026-12-01T03:00:00Z') }).ok, true);
});

test('unreadable ledger lines refuse; bad totals count at the estimate, never free', () => {
  const c = paceCheck({ rows: [{ unreadable: true, line: '<<<<<<< HEAD' }], atMs: at('2026-12-01T03:00:00Z') });
  assert.equal(c.ok, false);
  assert.match(c.reasons[0], /unreadable/);
  const r = ledgerReading([{ id: 'a', startedAt: '2026-11-01T15:00:00Z', status: 'graded', spendUsd: { total: -3 } }, { id: 'b', startedAt: '2026-11-01T16:00:00Z', status: 'graded' }], at('2026-12-01T03:00:00Z'));
  assert.equal(r.spentUsd, 10);
});

test('openingInstants drops a date it cannot place instead of keeping NaN', () => {
  const got = openingInstants([{ id: 'bad', category: 'broadway', openingDate: 'TBA' }], { embargoAt: () => 'not a date' });
  assert.deepEqual(got, []);
});
