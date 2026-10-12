// BRO-5136: theaterAddress follows venue on every shows.json write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncStaleTheaterAddresses } = require('./venue-address-sync.js');
const { getTheaterAddress } = require('./venue-addresses.js');
const { createShowsWriteGuard } = require('./shows-write-guard.js');

const STEINBERG = getTheaterAddress('Harold and Miriam Steinberg Center for Theatre');
const STUDIO54 = getTheaterAddress('Studio 54');

test('venue moved to Studio 54 with the Steinberg address left behind is synced (the 2026-10-12 shape)', () => {
  const shows = [{ id: 'kiss-me-kate-2019', venue: 'Studio 54', theaterAddress: STEINBERG }];
  const changed = syncStaleTheaterAddresses(shows);
  assert.equal(shows[0].theaterAddress, STUDIO54);
  assert.deepEqual(changed.map((c) => c.id), ['kiss-me-kate-2019']);
});

test('a hand-entered or unknown address is never rewritten', () => {
  const shows = [{ id: 'a', venue: 'Studio 54', theaterAddress: '254 West 54th Street, NYC' }];
  assert.deepEqual(syncStaleTheaterAddresses(shows), []);
  assert.equal(shows[0].theaterAddress, '254 West 54th Street, NYC');
});

test('unknown venue, null address, already-canonical address and non-Broadway shows are left alone', () => {
  const shows = [
    { id: 'u', venue: 'Some Barn', theaterAddress: STEINBERG },
    { id: 'n', venue: 'Studio 54', theaterAddress: null },
    { id: 'c', venue: 'Studio 54', theaterAddress: STUDIO54 },
    { id: 'we', category: 'west-end', venue: 'Studio 54', theaterAddress: STEINBERG },
  ];
  assert.deepEqual(syncStaleTheaterAddresses(shows), []);
  assert.equal(shows[0].theaterAddress, STEINBERG);
  assert.equal(shows[1].theaterAddress, null);
});

test('saveShows syncs a stale address on write (every writer is covered, not one script)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-sync-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: [{ id: 'x', title: 'X', status: 'closed', venue: 'Harold and Miriam Steinberg Center for Theatre', theaterAddress: STEINBERG }] }, null, 2));
  try {
    const { loadShows, saveShows } = createShowsWriteGuard(file);
    const data = loadShows();
    data.shows[0].venue = 'Studio 54';
    saveShows(data);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.shows[0].venue, 'Studio 54');
    assert.equal(written.shows[0].theaterAddress, STUDIO54);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
