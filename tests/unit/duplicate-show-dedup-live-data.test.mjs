// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json is itself the source of truth (discovery/hand-edited); structural alias/id-clash check plus one retired-id regression pin
// BRO-5737 (BRO-3425 pattern): live-data assertion split out of tests/unit/duplicate-show-dedup.test.mjs. shows.json gains bot
// discovery entries daily, so a live alias/id clash can redden code CI with no code change. Runs in check-corpus-drift.yml's
// "Live-data assertions" step, excluded from the unit batches in scripts/lib/unit-test-collection.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CANON_ID = 'crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026';

test('shows.json has no live entry for an id another show lists as an alias', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
  const shows = raw.shows || raw;
  const ids = new Set(shows.map(s => s.id));
  const clashes = [];
  for (const s of shows) for (const a of s.aliases || []) if (a !== s.id && ids.has(a)) clashes.push(`${a} (alias of ${s.id})`);
  assert.deepEqual(clashes, []);
  assert.equal(ids.has('crazy-mama-off-broadway-2026'), false);
  assert.equal(ids.has(CANON_ID), true);
});
