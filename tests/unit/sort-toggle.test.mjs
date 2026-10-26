// BRO-2762: the "Default" (custom) sort button on customSort browse pages is
// not reversible (it is a curated order), so clicking it while active is a
// no-op by design. It must say so via its tooltip instead of looking dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSortToggle } = require('../../src/lib/sort-toggle');
const src = readFileSync(new URL('../../src/components/BrowseListClient.tsx', import.meta.url), 'utf8');

test("'custom' is not toggleable: clicking it always yields 'custom', with no arrow", () => {
  const t = createSortToggle({ score: 'score_asc', alpha: 'alpha_desc' });
  assert.equal(t.isToggleable('custom'), false);
  assert.equal(t.getNextSort('custom', 'custom'), 'custom');
  assert.equal(t.getNextSort('custom', 'score_asc'), 'custom');
  assert.equal(t.getSortArrow('custom', 'custom'), '');
  assert.equal(t.normalizeSort('custom'), 'custom');
});

test('BrowseListClient gives the Default button an explanatory tooltip in both states', () => {
  assert.match(src, /s === 'custom'/);
  assert.match(src, /sort === 'custom' \? 'Showing the default order' : 'Click to restore the default order'/);
});
