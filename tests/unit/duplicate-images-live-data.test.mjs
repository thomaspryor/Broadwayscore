// TESTS-VS-DERIVED-DATA-EXEMPT: structural: no byte-identical art across unrelated shows; pins no show fact
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/duplicate-images.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/shows.json + public/), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/duplicate-images.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { auditDuplicateImages } = require('../../scripts/lib/duplicate-images.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOWS_JSON = path.join(ROOT, 'data', 'shows.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const realShows = fs.existsSync(SHOWS_JSON) ? JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8')).shows : null;

const noData = !realShows && 'data/shows.json missing (run scripts/setup-local-data.sh)';

test('real data: no byte-identical art across unrelated, unlinked shows', { skip: noData }, () => {
  const { groups } = auditDuplicateImages(realShows, PUBLIC_DIR);
  assert.deepEqual(groups.map((g) => `${g.ids.join(' | ')} (${g.files.map((x) => x.path).join(', ')})`), []);
});
