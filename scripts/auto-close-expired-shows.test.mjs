import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { closeExpiredShows, isStaleUkRegionalRun } = require('./lib/auto-close-expired.js');

const now = new Date('2026-10-11T12:00:00Z');
const mk = () => ({
  a: { id: 'a', status: 'open', closingDate: '2026-10-10', category: 'west-end' },
  b: { id: 'b', status: 'open', closingDate: '2026-10-11', category: 'broadway' },
  c: { id: 'c', status: 'open', category: 'broadway' },
  d: { id: 'd', status: 'closed', closingDate: '2026-01-01', category: 'broadway' },
});

test('past-closingDate open show is closed when apply=true', () => {
  const shows = mk();
  const list = closeExpiredShows(shows, { apply: true, now });
  assert.deepEqual(list.map(s => s.id), ['a']);
  assert.equal(shows.a.status, 'closed');
  assert.equal(shows.b.status, 'open');
  assert.equal(shows.c.status, 'open');
});

test('dry run reports but does not mutate', () => {
  const shows = mk();
  assert.equal(closeExpiredShows(shows, { now }).length, 1);
  assert.equal(shows.a.status, 'open');
});

test('market-local date: ET show closing today is not closed at 02:00Z next day', () => {
  const shows = { x: { id: 'x', status: 'open', closingDate: '2026-10-10', category: 'broadway' } };
  assert.equal(closeExpiredShows(shows, { now: new Date('2026-10-11T02:00:00Z') }).length, 0);
});

// The bug: the only writer was test.yml, which never commits.
test('a committing workflow runs the writer; test.yml only dry-runs', () => {
  const cmd = /run:\s*node scripts\/auto-close-expired-shows\.js(.*)/;
  const upd = fs.readFileSync(new URL('../.github/workflows/update-show-status.yml', import.meta.url), 'utf8');
  const tst = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const u = upd.match(cmd);
  assert.ok(u, 'update-show-status.yml must run auto-close-expired-shows.js');
  assert.ok(!u[1].includes('--dry-run'));
  assert.ok(upd.indexOf('auto-close-expired-shows.js') < upd.indexOf('- name: Validate data'));
  const t = tst.match(cmd);
  assert.ok(t && t[1].includes('--dry-run'), 'test.yml must not write');
});

test('UK regional open show with no closingDate closes after the stale window (BRO-6725)', () => {
  const uk = (id, openingDate, extra = {}) => ({ id, status: 'open', category: 'regional', venue: 'Royal Exchange Theatre', openingDate, ...extra });
  const shows = { old: uk('old', '2026-06-01'), fresh: uk('fresh', '2026-10-01'), dated: uk('dated', '2026-06-01', { closingDate: '2026-12-01' }) };
  const list = closeExpiredShows(shows, { apply: true, now });
  assert.deepEqual(list.map(s => s.id), ['old']);
  assert.equal(shows.fresh.status, 'open');
  assert.equal(shows.dated.status, 'open');
  // boundary: exactly 90 days old stays open, 91 closes
  assert.equal(isStaleUkRegionalRun(uk('b1', '2026-07-12'), '2026-10-10'), false);
  assert.equal(isStaleUkRegionalRun(uk('b2', '2026-07-11'), '2026-10-10'), true);
  assert.equal(isStaleUkRegionalRun({ category: 'broadway', openingDate: '2020-01-01' }, '2026-10-11'), false);
});

test('BRO-5489: a previews show past its closingDate closes; one with no or a future closingDate stays', () => {
  const shows = {
    p: { id: 'p', status: 'previews', closingDate: '2026-10-19', openingDate: null, category: 'west-end', _staleMissingSince: '2026-10-20' },
    q: { id: 'q', status: 'previews', closingDate: '2026-12-01', category: 'west-end' },
    r: { id: 'r', status: 'previews', category: 'regional', venue: 'Royal Exchange Theatre', openingDate: '2026-01-01' },
    u: { id: 'u', status: 'upcoming', closingDate: '2026-10-19', category: 'broadway' },
  };
  const out = closeExpiredShows(shows, { apply: true, now: new Date('2026-11-03T12:00:00Z') });
  assert.deepEqual(out.map((x) => x.id), ['p']);
  assert.equal(shows.p.status, 'closed');
  assert.equal(shows.p._staleMissingSince, undefined);
  assert.equal(shows.q.status, 'previews');
  assert.equal(shows.r.status, 'previews');
  assert.equal(shows.u.status, 'upcoming');
});
