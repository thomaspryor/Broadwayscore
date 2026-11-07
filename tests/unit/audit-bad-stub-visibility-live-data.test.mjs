// TESTS-VS-DERIVED-DATA-EXEMPT: structural reachability of the venue==title signature (count bound, every hit reachable); pins no show fact
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of tests/unit/audit-bad-stub-visibility.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/shows.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in tests/unit/audit-bad-stub-visibility.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isProvisional, isExemptFromPlaybillCheck, hasVenueEqualsTitleSignature } = require('../../scripts/validate-show-venue.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('live corpus: every venue===title entry is reachable by the sweep', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const hits = shows.filter(hasVenueEqualsTitleSignature);
  // An exempt entry (isExemptFromPlaybillCheck) is the only allowed exception.
  const unreachable = hits.filter((s) => !isProvisional(s) && !isExemptFromPlaybillCheck(s)).map((s) => s.id);
  assert.deepEqual(unreachable, []);
  // The signature must stay a narrow selector: it runs live SERP calls in CI.
  assert.ok(hits.length <= 10, `venue===title matched ${hits.length} entries; widen deliberately, not by accident`);
});
