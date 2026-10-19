/**
 * BRO-5647: isEstimate.capitalization prints the capitalization with "~", so a
 * record whose source reports the figure must not keep the flag. bro-5647-b
 * moved CATS to The Hollywood Reporter's reported $18M and left the flag set,
 * and the card still read "~$18.0M".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { commercialRecordWarnings } = require('../../scripts/lib/commercial-record-checks.js');
const { sourceOpensAsEstimate } = require('../../scripts/lib/public-source-text.js');

const REPORTED = 'The Hollywood Reporter (Jul 13, 2026): the production is capitalized at up to $18 million, per its SEC Form D filing.';
const ESTIMATE = 'Estimate (industry sources; other reports say up to $18 million). The producers have not disclosed it.';
const flagged = (src) => ({ designation: 'TBD', capitalization: 18000000, capitalizationSource: src, isEstimate: { weeklyRunningCost: false, capitalization: true } });
const flagWarnings = (rec, ctx) => commercialRecordWarnings('cats-the-jellicle-ball', rec, ctx).filter((w) => w.includes('isEstimate.capitalization'));

describe('isEstimate.capitalization needs an estimate source', () => {
  it('warns when the flag sits on a reported source (the CATS case)', () => {
    assert.strictEqual(flagWarnings(flagged(REPORTED)).length, 1);
  });
  it('warns when a write swaps an estimate source for a reported one and keeps the flag', () => {
    assert.strictEqual(flagWarnings(flagged(REPORTED), { priorRecord: flagged(ESTIMATE) }).length, 1);
  });
  it('passes a source that opens as an estimate', () => {
    assert.strictEqual(flagWarnings(flagged(ESTIMATE)).length, 0);
    assert.strictEqual(flagWarnings(flagged('~$8M per trade estimates')).length, 0);
  });
  it('passes a reported source once the flag is cleared', () => {
    const rec = { ...flagged(REPORTED), isEstimate: { weeklyRunningCost: false, capitalization: false } };
    assert.strictEqual(flagWarnings(rec).length, 0);
  });
  it('passes an unsourced flagged figure (it already prints "~")', () => {
    assert.strictEqual(flagWarnings(flagged(null)).length, 0);
  });
  it('does not block an unrelated edit to a record that already had the mismatch', () => {
    assert.strictEqual(flagWarnings(flagged(REPORTED), { priorRecord: flagged(REPORTED) }).length, 0);
  });
  it('sourceOpensAsEstimate reads only an opening marker', () => {
    assert.strictEqual(sourceOpensAsEstimate('Estimated from the tax credit'), true);
    assert.strictEqual(sourceOpensAsEstimate('About $12M per the SEC filing'), false);
    assert.strictEqual(sourceOpensAsEstimate(null), false);
  });
});
