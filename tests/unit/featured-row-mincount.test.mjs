import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { classifyFeaturedRows } = createRequire(import.meta.url)('../../scripts/lib/featured-row-mincount.js');

test('classifyFeaturedRows flags rows without minCount by distance from the default floor of 4', () => {
  const out = classifyFeaturedRows([
    { title: 'A', count: 3, minCount: null },
    { title: 'B', count: 5, minCount: null },
    { title: 'C', count: 6, minCount: null },
    { title: 'D', count: 1, minCount: 1 },
    { title: 'E', count: 2, minCount: 2 },
  ]);
  assert.deepEqual(out.map((f) => [f.title, f.status]), [['A', 'hidden'], ['B', 'at-risk'], ['C', 'ok']]);
});
