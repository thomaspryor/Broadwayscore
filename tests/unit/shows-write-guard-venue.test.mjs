// BRO-5579: every saveShows writer must pass the shared venue sanitizer.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard.js');
const { getTheaterAddress } = require('../../scripts/lib/venue-addresses.js');

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.cwd(), '.shows-venue-test-'));
  file = path.join(dir, 'shows.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(shows) {
  fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows }, null, 2) + '\n');
}
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

test('saveShows clears placeholders, blobs and malformed venues across markets', () => {
  const invalid = ['TBA', 'Midtown E', 'Soho/Tribeca', 'West End', '123', '', '  ', 123, {}, null];
  seed(invalid.map((venue, i) => ({
    id: `show-${i}`, category: ['broadway', 'off-broadway', 'west-end'][i % 3], venue,
  })));
  const guard = createShowsWriteGuard(file);
  const data = guard.loadShows();
  guard.saveShows(data);
  assert.deepEqual(read().shows.map(s => s.venue), invalid.map(() => null));
  assert.deepEqual(data.shows, read().shows, 'caller sees sanitized state');
});

test('named venues survive, accepted names are trimmed, missing fields stay absent', () => {
  seed([
    { id: 'broadway', venue: 'Studio 54' },
    { id: 'off-broadway', venue: '  The Public Theater  ' },
    { id: 'west-end', venue: 'Soho Theatre' },
    { id: 'unknown' },
  ]);
  const guard = createShowsWriteGuard(file);
  const data = guard.loadShows();
  guard.saveShows(data);
  assert.deepEqual(read().shows, [
    { id: 'broadway', venue: 'Studio 54' },
    { id: 'off-broadway', venue: 'The Public Theater' },
    { id: 'west-end', venue: 'Soho Theatre' },
    { id: 'unknown' },
  ]);
  const first = read().shows;
  guard.saveShows(data);
  assert.deepEqual(read().shows, first, 'checkpoint saves are idempotent');
});

test('new records and saves without a load snapshot are sanitized too', () => {
  seed([{ id: 'existing', venue: 'Adelphi Theatre' }]);
  createShowsWriteGuard(file).saveShows({ shows: [
    { id: 'existing', venue: 'Adelphi Theatre' },
    { id: 'added', venue: 'TBA' },
  ] });
  assert.equal(read().shows[1].venue, null);
});

test('validation runs after merging concurrent records, keeping unrelated changes', () => {
  seed([{ id: 'a', venue: 'Adelphi Theatre' }]);
  const guard = createShowsWriteGuard(file);
  const stale = guard.loadShows();
  // A different writer adds a bad venue after this caller loaded its snapshot.
  seed([
    { id: 'a', venue: 'Soho Theatre', status: 'open' },
    { id: 'concurrent', venue: 'Midtown E' },
  ]);
  guard.saveShows(stale);
  assert.deepEqual(read().shows, [
    { id: 'a', venue: 'Soho Theatre', status: 'open' },
    { id: 'concurrent', venue: null },
  ]);
  assert.deepEqual(stale.shows, read().shows);
});

test('mutateFresh saves cannot bypass validation', () => {
  seed([{ id: 'a', venue: 'Adelphi Theatre' }]);
  const guard = createShowsWriteGuard(file);
  guard.saveShows(guard.loadShows(), {
    mutateFresh: fresh => { fresh.shows[0].venue = 'TBA'; },
  });
  assert.equal(read().shows[0].venue, null);
});

test('a dry run neither writes nor sanitizes the caller', () => {
  seed([{ id: 'a', venue: 'TBA' }]);
  const before = fs.readFileSync(file, 'utf8');
  const guard = createShowsWriteGuard(file, { dryRun: true });
  const data = guard.loadShows();
  const result = guard.saveShows(data);
  assert.equal(result.wrote, false);
  assert.equal(data.shows[0].venue, 'TBA');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('address sync still follows an accepted, trimmed venue', () => {
  seed([{
    id: 'moved', venue: '  Studio 54  ',
    theaterAddress: getTheaterAddress('Harold and Miriam Steinberg Center for Theatre'),
  }]);
  const guard = createShowsWriteGuard(file);
  guard.saveShows(guard.loadShows());
  assert.equal(read().shows[0].venue, 'Studio 54');
  assert.equal(read().shows[0].theaterAddress, getTheaterAddress('Studio 54'));
});
