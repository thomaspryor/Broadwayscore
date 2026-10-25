/**
 * Drift gate: src/lib/stats-ui/theater-houses.json must equal the projection
 * of data/theater-metadata.json (the REAL scripts/lib/theater-houses.js, per
 * CLAUDE.md §15). A house added or a capacity corrected in the metadata would
 * otherwise never reach the web Stats theater ring.
 *
 * Skips (loudly) when the metadata file is absent, e.g. a cloud stub checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { METADATA_PATH, HOUSES_PATH, projectTheaterHouses, serializeTheaterHouses } = require('../../scripts/lib/theater-houses.js');

const metadataPresent = existsSync(METADATA_PATH);

test('theater-houses.json matches data/theater-metadata.json', { skip: !metadataPresent && 'SKIPPED: data/theater-metadata.json absent' }, () => {
  const full = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
  const committed = readFileSync(HOUSES_PATH, 'utf8');
  assert.equal(committed, serializeTheaterHouses(full), 'theater-houses.json is stale: run node scripts/generate-theater-houses.js');
  // Guard the guard: a stub metadata file must not "pass" with an empty list.
  assert.ok(Object.keys(JSON.parse(committed)).length >= 40, 'expected ~41 Broadway houses');
});

test('projection keeps only capacity, yearBuilt and non-empty formerNames, and skips _meta', () => {
  const slim = projectTheaterHouses({
    _meta: { description: 'not a house' },
    'Lena Horne Theatre': { capacity: 1069, yearBuilt: 1926, formerNames: ['Brooks Atkinson Theatre'], tips: ['x'], lat: 40.7 },
    'Booth Theatre': { capacity: 766, yearBuilt: 1913, formerNames: [] },
    'New House': { capacity: '1,000' },
  });
  assert.deepEqual(slim, {
    'Lena Horne Theatre': { capacity: 1069, yearBuilt: 1926, formerNames: ['Brooks Atkinson Theatre'] },
    'Booth Theatre': { capacity: 766, yearBuilt: 1913 },
    'New House': {},
  });
});
