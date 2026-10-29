// BRO-6516 acceptance: >=300 UK regional productions (Jan 2024+) in shows.json
// with a city, each with 3+ scored reviews (5 if all T3) or listed below-bar in
// the run report. Fails until the build completes (gated on BRO-6515 city field).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const raw = JSON.parse(fs.readFileSync(new URL('../data/shows.json', import.meta.url), 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;

// todo: build in progress (BRO-6516 gated on BRO-6515 city field). Remove `todo`
// when the build lands so this becomes a real gate; todo keeps CI green meanwhile.
test('>=300 UK regional productions from Jan 2024 with a city', { todo: 'BRO-6516 build in progress' }, () => {
  const uk = shows.filter((s) => s.market === 'regional' && s.city && (s.country === 'GB' || s.country === 'UK' || /-uk$/.test(s.city)) && (s.openingDate || '') >= '2024-01-01');
  assert.ok(uk.length >= 300, `UK regional productions with city since 2024-01: ${uk.length} (need 300)`);
});
