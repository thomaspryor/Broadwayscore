import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { perShowSerpTargets } = require('../../scripts/lib/outlet-listing-helpers.js');

test('NY Sun searches a recent Off-Broadway opening before London shows when capped', () => {
  const shows = [
    { id: 'the-dead-1904-off-broadway-2026', title: 'The Dead, 1904', openingDate: '2026-11-24', category: 'off-broadway' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `london-${i}`, title: `London ${i}`, openingDate: '2026-11-20', category: 'west-end' })),
  ];
  const now = Date.parse('2026-11-25T11:00:00Z');
  assert.ok(perShowSerpTargets(shows, 30, now, 'new-york-sun').some(s => s.id === shows[0].id));
  assert.ok(!perShowSerpTargets(shows, 30, now, 'financialtimes').some(s => s.id === shows[0].id));
});
