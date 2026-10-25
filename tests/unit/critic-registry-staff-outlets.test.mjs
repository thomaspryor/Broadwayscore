/**
 * BRO-4551 live-data regression: Peter Marks is Washington Post staff
 * (non-freelancer). A misattributed mj-2022 Variety row leaked `variety` into
 * his critic-registry knownOutlets. Requires the core-data checkout
 * (data/critic-registry.json); registered in the e2e (live-data) manifest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'data', 'critic-registry.json'), 'utf8')).critics;

test('peter-marks (WaPo staff) knownOutlets excludes variety', () => {
  const marks = registry['peter-marks'];
  assert.ok(marks, 'peter-marks missing from critic-registry');
  assert.equal(marks.isFreelancer, false);
  assert.ok(marks.knownOutlets.includes('washpost'));
  assert.ok(!marks.knownOutlets.includes('variety'), `variety leaked: ${JSON.stringify(marks.outletCounts)}`);
  assert.equal(marks.outletCounts?.variety, undefined);
});
