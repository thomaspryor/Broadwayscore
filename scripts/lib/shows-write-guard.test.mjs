// BRO-5271: shows-write-guard strips the stale 'upcoming' tag on every save,
// so whichever writer moves a show past upcoming, the tag cannot be stored.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard, stripStaleUpcomingTags } = require('./shows-write-guard.js');
const { PAST_UPCOMING_STATUSES } = require('./opening-night-completeness.js');

let dir;
let file;
// Filler keeps dropped tag lines under atomicWriteJson's 5% shrink gate.
const FILLER = Array.from({ length: 40 }, (_, i) => ({ id: `filler-${i}`, status: 'open', tags: ['musical'] }));

function seed(shows) {
  fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: [...shows, ...FILLER] }, null, 2) + '\n');
}
const onDisk = (id) => JSON.parse(fs.readFileSync(file, 'utf8')).shows.find((s) => s.id === id);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-guard-upcoming-'));
  file = path.join(dir, 'shows.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("saving an 'open' row tagged ['upcoming'] removes the tag", () => {
  seed([{ id: 'a', status: 'upcoming', tags: ['upcoming'] }]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.find((s) => s.id === 'a').status = 'open';
  g.saveShows(data);
  assert.deepEqual(onDisk('a').tags, []);
  assert.equal(onDisk('a').status, 'open');
  assert.deepEqual(data.shows.find((s) => s.id === 'a').tags, [], 'caller object synced to the written state');
});

test('strip applies for every PAST_UPCOMING_STATUSES status, any case, keeping other tags', () => {
  assert.ok(PAST_UPCOMING_STATUSES.length >= 3);
  seed(PAST_UPCOMING_STATUSES.map((status) => ({ id: `s-${status}`, status, tags: ['Upcoming', 'musical', 'upcoming'] })));
  const g = createShowsWriteGuard(file);
  g.saveShows(g.loadShows());
  for (const status of PAST_UPCOMING_STATUSES) {
    assert.deepEqual(onDisk(`s-${status}`).tags, ['musical'], status);
  }
});

test('upcoming/announced rows keep their tag; other tags and statuses untouched', () => {
  seed([
    { id: 'up', status: 'upcoming', tags: ['upcoming', 'musical'] },
    { id: 'ann', status: 'announced', tags: ['Upcoming', 'play'] },
    { id: 'open-clean', status: 'open', tags: ['musical', 'revival'] },
    { id: 'no-tags', status: 'closed' },
  ]);
  const g = createShowsWriteGuard(file);
  g.saveShows(g.loadShows());
  assert.deepEqual(onDisk('up').tags, ['upcoming', 'musical']);
  assert.deepEqual(onDisk('ann').tags, ['Upcoming', 'play']);
  assert.deepEqual(onDisk('open-clean').tags, ['musical', 'revival']);
  assert.equal(onDisk('no-tags').tags, undefined);
});

test('a dry-run guard never writes, so never strips', () => {
  seed([{ id: 'a', status: 'open', tags: ['upcoming'] }]);
  const before = fs.readFileSync(file, 'utf8');
  const g = createShowsWriteGuard(file, { dryRun: true });
  g.saveShows(g.loadShows());
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('stripStaleUpcomingTags returns the ids it changed and tolerates bad input', () => {
  const shows = [
    { id: 'p', status: 'previews', tags: ['UPCOMING'] },
    { id: 'u', status: 'upcoming', tags: ['upcoming'] },
    { id: 'x', status: 'open', tags: 'not-an-array' },
    null,
  ];
  assert.deepEqual(stripStaleUpcomingTags(shows), ['p']);
  assert.deepEqual(shows[0].tags, []);
  assert.deepEqual(shows[1].tags, ['upcoming']);
  assert.deepEqual(stripStaleUpcomingTags(undefined), []);
});
