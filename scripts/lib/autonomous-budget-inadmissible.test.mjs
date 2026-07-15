import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inadmissibleSizes, ENVELOPES, DEFAULTS } = require('./autonomous-budget.js');

// 2026-07-15 incident: nightUSD $5 with sizes S,M — M worst-case $7.50 can
// never be admitted ($4.50 available after reserve), so an M-only night burns
// triage spend and attempts nothing, silently. inadmissibleSizes() is the
// detection the run warns on.

test('$5 night with S,M: M is dead, S is fine (the 2026-07-15 deadlock)', () => {
  const dead = inadmissibleSizes({ nightUSD: 5, sizes: ['S', 'M'] });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].size, 'M');
  assert.equal(dead[0].worstCaseUSD, 7.5);
  assert.equal(dead[0].availableUSD, 4.5);
});

test('$8 night with S,M: nothing dead (M worst-case 7.50 ≤ 7.50 available)', () => {
  assert.deepEqual(inadmissibleSizes({ nightUSD: 8, sizes: ['S', 'M'] }), []);
});

test('L is never reported dead — incremental cards are not admitted whole', () => {
  assert.deepEqual(inadmissibleSizes({ nightUSD: 1, sizes: ['L'] }), []);
});

test('unknown sizes are ignored, not crashed on', () => {
  assert.deepEqual(inadmissibleSizes({ nightUSD: 5, sizes: ['XL', 'nope'] }), []);
});

test('threshold math matches the real envelopes and default reserve', () => {
  // For every non-incremental envelope: a night budgeted exactly at
  // worst-case + reserve admits it; a cent less kills it.
  for (const [size, env] of Object.entries(ENVELOPES)) {
    if (env.incremental) continue;
    const worst = env.estUSD + env.estAttempt2USD;
    assert.deepEqual(inadmissibleSizes({ nightUSD: worst + DEFAULTS.reserveUSD, sizes: [size] }), [], `${size} at exact fit`);
    assert.equal(inadmissibleSizes({ nightUSD: worst + DEFAULTS.reserveUSD - 0.01, sizes: [size] }).length, 1, `${size} one cent short`);
  }
});
