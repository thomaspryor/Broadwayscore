// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json is itself the source of truth (discovery/hand-edited); structural alias/id-clash check plus one retired-id regression pin
// BRO-4049: crazy-mama-off-broadway-2026 (TodayTix stub) duplicated
// crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026 (59E59 venue
// page). Discovery filed opening-night reviews under the stub id. Requires the
// real dedup functions; asserts against the real shows.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { checkForDuplicate, venuesMatch } = require('../../scripts/lib/deduplication.js');

const CANON = {
  id: 'crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026',
  title: 'Crazy Mama: A True Story of Love and Madness',
  venue: '59E59 Theaters, Theater C',
  status: 'open', openingDate: '2026-09-22', closingDate: '2026-10-18',
  previewsStartDate: '2026-09-16', category: 'off-broadway', market: 'broadway',
};

test('same-venue title-prefix stub is flagged as a duplicate (comma and dash venue spellings)', () => {
  for (const venue of ['59E59 Theaters, Theater C', '59E59 Theaters - Theater C']) {
    const stub = { id: 'crazy-mama-off-broadway-2026', title: 'Crazy Mama', venue,
      status: 'previews', previewsStartDate: '2026-09-16', category: 'off-broadway', market: 'broadway' };
    const r = checkForDuplicate(stub, [CANON]);
    assert.equal(r.isDuplicate, true, venue);
    assert.equal(r.existingShow.id, CANON.id);
  }
});

test('sibling rooms at the same venue stay distinct', () => {
  assert.equal(venuesMatch('59E59 Theaters, Theater A', '59E59 Theaters, Theater C'), false);
});

test('shows.json has no live entry for an id another show lists as an alias', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
  const shows = raw.shows || raw;
  const ids = new Set(shows.map(s => s.id));
  const clashes = [];
  for (const s of shows) for (const a of s.aliases || []) if (a !== s.id && ids.has(a)) clashes.push(`${a} (alias of ${s.id})`);
  assert.deepEqual(clashes, []);
  assert.equal(ids.has('crazy-mama-off-broadway-2026'), false);
  assert.equal(ids.has(CANON.id), true);
});
