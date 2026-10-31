// TESTS-VS-DERIVED-DATA-EXEMPT: asserts one-way floors (no show drops below its backfilled count), not exact facts; review-texts source is absent from most checkouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BRO-3552: after the BRO-1351 SERP matcher fix, closed shows with a declared
// priorRun were re-gathered through the real gather-reviews.yml workflow.
// `before` is each show's count when the card was filed; `floor` is what the
// backfill left in data/reviews.json (2026-10-22). A show that falls under its
// floor lost coverage the backfill had recovered.
const reviewsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'reviews.json');
const SHOWS = {
  'kanpur-1857-off-west-end-2026': { before: 0, floor: 1 },
  'this-is-not-about-me-off-west-end-2026': { before: 2, floor: 7 },
  'rosie-odonnell-common-knowledge-off-broadway-2026': { before: 4, floor: 3 },
  'horrible-histories-barmy-britain-the-best-bits-west-end-2026': { before: 5, floor: 5 },
  'jeezus-off-west-end-2026': { before: 6, floor: 6 },
  'burnt-up-love-off-west-end-2026': { before: 6, floor: 6 },
  'rheology-off-broadway-2026': { before: 7, floor: 8 },
  'don-giovanni-off-broadway-2025': { before: 7, floor: 7 },
};

const present = fs.existsSync(reviewsPath);
const counts = {};
if (present) {
  const all = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews;
  for (const r of Array.isArray(all) ? all : Object.values(all)) counts[r.showId] = (counts[r.showId] || 0) + 1;
}

for (const [id, { before, floor }] of Object.entries(SHOWS)) {
  test(`${id} keeps its backfilled coverage (was ${before})`, { skip: !present && 'data/reviews.json not present' }, () => {
    assert.ok((counts[id] || 0) >= floor, `${id}: ${counts[id] || 0} reviews, expected at least ${floor}`);
  });
}

test('kanpur recovered coverage it had none of before the matcher fix', { skip: !present && 'data/reviews.json not present' }, () => {
  assert.ok((counts['kanpur-1857-off-west-end-2026'] || 0) > SHOWS['kanpur-1857-off-west-end-2026'].before);
});
