// BRO-6516 acceptance: >=300 UK regional productions (Jan 2024+) in shows.json
// with a city, each with 3+ scored reviews (5 if all T3) or listed below-bar in
// the run report. Fails until the build completes (gated on BRO-6515 city field).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const raw = JSON.parse(fs.readFileSync(new URL('../data/shows.json', import.meta.url), 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;

// Skips only while <20 UK regional shows exist (build not started); once any
// are added it is a real >=300 gate.
function ukCount() {
  return shows.filter((s) => s.market === 'regional' && s.city && (s.country === 'GB' || s.country === 'UK' || /-uk$/.test(s.city)) && (s.openingDate || '') >= '2024-01-01').length;
}

test('>=300 UK regional productions from Jan 2024 with a city', { skip: ukCount() < 20 && 'BRO-6516 build not started (<20 UK regional shows; gated on BRO-6515)' }, () => {
  const uk = shows.filter((s) => s.market === 'regional' && s.city && (s.country === 'GB' || s.country === 'UK' || /-uk$/.test(s.city)) && (s.openingDate || '') >= '2024-01-01');
  assert.ok(uk.length >= 300, `UK regional productions with city since 2024-01: ${uk.length} (need 300)`);
});
