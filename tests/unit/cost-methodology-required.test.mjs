/** BRO-6297: a cited weekly cost needs a costMethodology (site/model parity, BRO-5632). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commercialRecordErrors } = require('../../scripts/lib/commercial-record-checks');

const base = { weeklyRunningCost: 700000, weeklyRunningCostSource: 'Production budget from an industry source (Oct 2026): "TOTAL $700,000"' };
const has = (r) => commercialRecordErrors('x', r).some((e) => /no costMethodology/.test(e));

test('cited cost without costMethodology is an error', () => assert.ok(has(base)));
test('with a costMethodology, or with no cost, it is not', () => {
  assert.ok(!has({ ...base, costMethodology: 'producer-confirmed' }));
  assert.ok(!has({ weeklyRunningCost: 700000 }));
});
