// BRO-7167: the old-path audit grades from the observed embargo when step 1 found one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pressNightWithObserved } = require('./test-bench-old-path-audit.js');

test('observed cluster replaces the recorded embargo, keeping the rest of the record', () => {
  const rec = { embargoAt: '2026-10-30T02:00:00Z', perReview: [1] };
  const out = pressNightWithObserved(rec, { observed: { source: 'observed-cluster', at: '2026-10-30T03:00:00.000Z' } });
  assert.equal(out.embargoAt, '2026-10-30T03:00:00.000Z');
  assert.deepEqual(out.perReview, [1]);
  assert.equal(rec.embargoAt, '2026-10-30T02:00:00Z');
});

test('no cluster keeps the record (or null)', () => {
  const rec = { embargoAt: 'x' };
  assert.equal(pressNightWithObserved(rec, { observed: { source: 'estimate', at: 'y' } }), rec);
  assert.equal(pressNightWithObserved(null, null), null);
  assert.equal(pressNightWithObserved(null, { observed: { source: 'observed-cluster', at: 'z' } }).embargoAt, 'z');
});
