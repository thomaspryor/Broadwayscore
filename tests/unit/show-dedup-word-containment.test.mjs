// BRO-4315: Check 8 title containment matches whole words only.
// normalizeTitle strips a possessive prefix ("A Midsummer Night's Dream" ->
// "dream"), and a raw substring test then matched it inside "dreamgirls",
// failing validate-data and every rename-show-ids.yml run on 2026-10-29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate } = require('../../scripts/lib/deduplication.js');

test('a word inside a longer word is not title containment', () => {
  const r = checkForDuplicate(
    // The real rows from shows.json.
    { id: 'a-midsummer-nights-dream-chichester-festival-regional-2026', slug: 'a-midsummer-nights-dream-chichester-festival-regional-2026', title: "A Midsummer Night's Dream", venue: 'Chichester Festival Theatre, Chichester', openingDate: '2026-09-27', category: 'regional' },
    [{ id: 'dreamgirls-2026', slug: 'dreamgirls', title: 'Dreamgirls', venue: null, openingDate: null, category: 'broadway' }],
  );
  assert.equal(r.isDuplicate, false, r.reason);
});

test('whole-word containment still flags a duplicate', () => {
  const r = checkForDuplicate(
    { id: 'fun-home-revival-2026', slug: 'fun-home-revival', title: 'Fun Home Revival', venue: 'Circle in the Square Theatre', category: 'broadway' },
    [{ id: 'fun-home-2026', slug: 'fun-home', title: 'Fun Home', venue: 'Circle in the Square Theatre', category: 'broadway' }],
  );
  assert.equal(r.isDuplicate, true);
});
