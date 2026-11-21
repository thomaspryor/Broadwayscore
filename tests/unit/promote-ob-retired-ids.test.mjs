// BRO-5557: the Il Cimento duplicate (NYU Skirball venue page) was retired on
// 2026-10-13 and re-minted under the same id on 2026-10-16 because
// promote-ob-venue-candidates.js never consulted data/retired-show-ids.json
// (promote-owe-venue-candidates.js does). Tests the REAL builder + registry matcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildShowEntry } = require('../../scripts/promote-ob-venue-candidates.js');
const { matchesRetired } = require('../../scripts/lib/retired-show-ids.js');

const RETIRED_ID = 'anne-teresa-de-keersmaeker-radouan-mriziga-il-cimento-dellarmonia-e-dellinventione-off-broadway-2027';
const registry = [{ id: RETIRED_ID, reason: 'Duplicate of the TodayTix Il Cimento row', retiredAt: '2026-10-13T00:17:20.146Z', title: null, venue: null }];

test('the id the OB promoter mints for the retired Il Cimento row is a registry hit', () => {
  const entry = buildShowEntry({
    title: "Anne Teresa De Keersmaeker & Radouan Mriziga: Il Cimento dell'Armonia e dell'Inventione",
    venue: 'NYU Skirball', source: 'venue-page:nyu-skirball', category: 'off-broadway',
    slug: 'anne-teresa-de-keersmaeker-radouan-mriziga-il-cimento-dellarmonia-e-dellinventione',
    previewsStartDate: '2027-04-22', closingDate: '2027-04-24', discoveredAt: '2026-10-16T12:49:43.388Z',
  });
  assert.equal(entry.id, RETIRED_ID);
  assert.deepEqual(matchesRetired({ id: entry.id, title: entry.title, venue: entry.venue }, registry), { id: RETIRED_ID, matchedBy: 'id' });
});

test('promote-ob-venue-candidates refuses a retired id before it can mint the row', () => {
  const src = fs.readFileSync(new URL('../../scripts/promote-ob-venue-candidates.js', import.meta.url), 'utf8');
  const retired = src.indexOf('matchesRetired({ id: entry.id');
  const collision = src.indexOf('existingIds.has(entry.id)');
  assert.ok(retired > 0, 'matchesRetired call present');
  assert.ok(src.includes('loadRetiredIds()'), 'registry loaded once per run');
  assert.ok(retired < collision, 'retired check runs before the id-collision check and the push');
});
