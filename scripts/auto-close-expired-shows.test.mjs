import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { closeExpiredShows } = require('./lib/auto-close-expired.js');

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
