import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoredShowIds, isDetailVisible } = require('./mobile-detail-visibility.js');

test('scoredShowIds keeps shows with at least one assigned score (0 counts)', () => {
  const ids = scoredShowIds([
    { showId: 'a', assignedScore: 80 },
    { showId: 'b', assignedScore: null },
    { showId: 'c' },
    { showId: 'd', assignedScore: 0 },
  ]);
  assert.deepEqual([...ids].sort(), ['a', 'd']);
  assert.equal(scoredShowIds(undefined).size, 0);
});

test('isDetailVisible: open shows yes, closed only when scored', () => {
  const scored = new Set(['closed-scored']);
  assert.equal(isDetailVisible({ id: 'x', category: 'broadway', status: 'open' }, scored), true);
  assert.equal(isDetailVisible({ id: 'closed-scored', category: 'broadway', status: 'closed' }, scored), true);
  assert.equal(isDetailVisible({ id: 'closed-unscored', category: 'off-broadway', status: 'closed' }, scored), false);
});
