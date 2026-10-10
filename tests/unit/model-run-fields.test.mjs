// BRO-4989 G: shadow return fields written by the model run. require()s the real module (§15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { clearStaleModelFields, applyShadowReturnFields, SHADOW_RETURN_FIELDS } = require('../../scripts/lib/model-run-fields');
const { modelReturnV2 } = require('../../scripts/lib/model-return-v2');
const { MODEL_RUN_FIELDS } = require('../../scripts/lib/merge-commercial-data');

const NOW = Date.parse('2026-10-01');
const closed = { closingDate: '2025-01-01' };
const result = (svog) => ({
  capitalization: 10_000_000, svogGrant: svog, reserveFund: 1_000_000,
  pessimistic: { cumulativeProfit: 1e6 }, central: { cumulativeProfit: 2e6 }, optimistic: { cumulativeProfit: 3e6 },
});

describe('applyShadowReturnFields', () => {
  it('writes the modelReturnV2 output and leaves modelRecoupmentPct alone', () => {
    const comm = { modelRecoupmentPct: [1, 2, 3] };
    applyShadowReturnFields(comm, result(9e6), closed, NOW);
    const v2 = modelReturnV2(result(9e6), closed, NOW);
    assert.deepStrictEqual(comm.modelRecoupmentPctV2, v2.recoupmentPctV2);
    assert.deepStrictEqual(comm.modelInvestorMultiple, v2.investorMultiple);
    assert.deepStrictEqual(comm.modelRecoupmentPct, [1, 2, 3]);
  });

  it('SVOG near cap stays proportional (live would explode)', () => {
    const comm = {};
    applyShadowReturnFields(comm, result(9.5e6), closed, NOW);
    assert.ok(comm.modelRecoupmentPctV2[1] < 200, String(comm.modelRecoupmentPctV2));
  });

  it('an unscorable result clears stale shadow values', () => {
    const comm = { modelRecoupmentPctV2: [9, 9, 9], modelInvestorMultiple: [1, 1, 1] };
    assert.strictEqual(applyShadowReturnFields(comm, { ...result(0), capitalization: 0 }, closed, NOW), null);
    for (const f of SHADOW_RETURN_FIELDS) assert.ok(!(f in comm), f);
  });
});

describe('clearStaleModelFields', () => {
  it('clears the shadow fields with the live run fields', () => {
    const comm = { modelRecoupmentPct: [1, 2, 3], modelRecouped: false, modelRecoupmentPctV2: [1, 2, 3], modelInvestorMultiple: [0, 0, 0], designation: 'TBD' };
    clearStaleModelFields(comm);
    assert.deepStrictEqual(comm, { designation: 'TBD' });
  });

  it('shadow fields merge as part of the model run unit', () => {
    for (const f of SHADOW_RETURN_FIELDS) assert.ok(MODEL_RUN_FIELDS.includes(f), f);
  });
});
