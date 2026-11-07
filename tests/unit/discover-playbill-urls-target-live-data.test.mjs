// TESTS-VS-DERIVED-DATA-EXEMPT: structural: asserts only that the live corpus has at least one Broadway target (count > 0)
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of tests/unit/discover-playbill-urls-target.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/shows.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in tests/unit/discover-playbill-urls-target.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isDiscoverTarget } = require('../../scripts/discover-playbill-urls.js');

test('the live corpus has at least one target', { skip: !fs.existsSync('data/shows.json') }, () => {
  const { shows } = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  assert.ok(shows.filter(isDiscoverTarget).length > 0);
});
