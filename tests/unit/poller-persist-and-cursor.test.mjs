// BRO-7162 F06 + F08 class guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { advanceSerpOutletOffset, rotateMissingOutlets } = require('../../scripts/lib/opening-night-discovery-policy.js');
const src = fs.readFileSync(new URL('../../scripts/opening-night-poller.js', import.meta.url), 'utf8');

test('F08: cursor advances by outlets reached, not by the budget', () => {
  assert.equal(advanceSerpOutletOffset(3, 0, 20), 3, 'nothing attempted leaves the cursor');
  assert.equal(advanceSerpOutletOffset(3, 5, 20), 8);
  assert.equal(advanceSerpOutletOffset(18, 5, 20), 3, 'wraps');
  assert.equal(advanceSerpOutletOffset(0, 12, 0), 0, 'empty list is safe');
  // An early-stopped pass resumes exactly where it left off
  const list = Array.from({ length: 20 }, (_, i) => ({ id: 'o' + i }));
  const first = rotateMissingOutlets(list, 0).slice(0, 4).map(o => o.id);
  const next = rotateMissingOutlets(list, advanceSerpOutletOffset(0, 4, 20))[0].id;
  assert.deepEqual(first, ['o0', 'o1', 'o2', 'o3']);
  assert.equal(next, 'o4');
});

test('F08 source guard: poller no longer advances the cursor by SERP_BUDGET', () => {
  assert.ok(!/nextSerpOutletOffset \+ SERP_BUDGET/.test(src));
  assert.match(src, /advanceSerpOutletOffset\(nextSerpOutletOffset, serpStats\.consumed/);
});

test('F06 source guard: every parallel discovery layer is persisted as it settles', () => {
  const block = src.slice(src.indexOf('Promise.allSettled(['), src.indexOf('Promise.allSettled([') + 1200);
  for (const label of ['Layer 1', 'Layer 2', 'Layer 3 SSR', 'Layer 2b', 'google-news-rss']) {
    assert.ok(block.includes(`persistLayerOnSettle('${label}'`), `${label} must be persisted on settle`);
  }
});
