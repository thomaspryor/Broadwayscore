// Unit tests for scripts/score-commercial-blind-test.js (BRO-4990).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { scoreRun, outcomeClass } = require('../../scripts/score-commercial-blind-test');

describe('scoreRun', () => {
  const truth = {
    harmony: { designation: 'Flop', recouped: false, capitalization: 15e6 },
    six: { designation: 'Windfall', recouped: true, capitalization: 5e6 },
    'music-man': { designation: 'Fizzle', recouped: false, capitalization: 24e6 },
    parade: { designation: 'Fizzle', recouped: false, capitalization: 6.5e6 },
  };
  const results = {
    harmony: { designation: 'flop', recouped: false, capitalization: 15e6, confidence: 'medium', _cost: { usd: 0.3 } },
    six: { designation: 'Windfall', recouped: true, capitalization: 12e6, confidence: 'high', _cost: { usd: 0.2 } },
    'music-man': { designation: 'Easy Winner', recouped: true, capitalization: 24e6, confidence: 'medium', _cost: { usd: 0.3 } },
    parade: { designation: 'TBD', confidence: 'low', _cost: { usd: 0.2 } },
  };
  const s = scoreRun(results, truth);

  it('normalizes designation case like the apply step', () => {
    assert.equal(s.rows.find(r => r.slug === 'harmony').designationMatch, true);
  });

  it('scores exact, outcome side, recouped and cap; TBD is unanswered, not wrong', () => {
    assert.deepEqual(s.designation, { hit: 2, of: 3 });
    assert.deepEqual(s.outcome, { hit: 2, of: 3 });
    assert.deepEqual(s.recouped, { hit: 2, of: 3 });
    assert.deepEqual(s.cap, { hit: 2, of: 3 });
    assert.equal(s.fillDesignation, 3);
    assert.ok(Math.abs(s.totalCost - 1.0) < 1e-9);
  });

  it('groups designations by side of recoupment', () => {
    assert.equal(outcomeClass('Trickle'), 'recouped');
    assert.equal(outcomeClass('Flop'), 'lost');
    assert.equal(outcomeClass('TBD'), null);
  });
});
