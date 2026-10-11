// BRO-5020: no writer assigns a new Fizzle/Flop without a cited loss source.
// Requires the real functions (no inline copies).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { filterByConfidence } = require('../../scripts/update-commercial-data.js');

const data = { shows: { 'x-show': { designation: 'TBD' } } };
const change = (newValue, confidence) => ({ slug: 'x-show', field: 'designation', oldValue: 'TBD', newValue, confidence, source: 'test' });

describe('update-commercial-data loss-label freeze', () => {
  for (const loss of ['Fizzle', 'Flop']) {
    it(`flags TBD -> ${loss} at medium confidence instead of applying it`, () => {
      const r = filterByConfidence([change(loss, 'medium')], data);
      assert.equal(r.applied.length, 0);
      assert.equal(r.flagged.length, 1);
      assert.match(r.flagged[0].flagReason, /cited loss source/);
    });
    it(`applies TBD -> ${loss} at high confidence (directly stated loss)`, () => {
      const r = filterByConfidence([change(loss, 'high')], data);
      assert.equal(r.applied.length, 1);
    });
  }
  it('still applies TBD -> Windfall at medium confidence (unchanged)', () => {
    const r = filterByConfidence([change('Windfall', 'medium')], data);
    assert.equal(r.applied.length, 1);
  });
});
