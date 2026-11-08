// BRO-7162 F07 class guards: Strategy 1 must leave SERP budget for news + broad queries,
// list one entry per domain, rotate across runs, and keep specialists inside the cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { strategyOneCap, planStrategyOneTargets } = require('../../scripts/lib/opening-night-discovery-policy.js');

test('strategyOneCap reserves up to 2 calls, never below 1 when budget allows', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 80].map(strategyOneCap), [0, 1, 1, 2, 2, 78]);
  assert.equal(strategyOneCap(NaN), 0);
  assert.equal(strategyOneCap(-5), 0);
});

const domainOf = id => id.split('~')[0];

test('plan dedupes aliases by domain and drops unknown domains', () => {
  const out = planStrategyOneTargets(['a~1', 'a~2', 'b~1', 'zz'], [], id => (id === 'zz' ? null : domainOf(id)), { cap: 10 });
  assert.deepEqual(out, ['a~1', 'b~1']);
});

test('rotation reaches every domain within ceil(L/cap) runs', () => {
  const main = Array.from({ length: 25 }, (_, i) => `d${i}~1`);
  const cap = 6, seen = new Set();
  for (let run = 0; run < Math.ceil(25 / cap); run++) {
    planStrategyOneTargets(main, [], domainOf, { cap, runIndex: run }).slice(0, cap).forEach(x => seen.add(x));
  }
  assert.equal(seen.size, 25);
});

test('specialists land inside the cap and are not duplicated with main domains', () => {
  const main = Array.from({ length: 50 }, (_, i) => `m${i}~1`);
  const spec = ['s1~1', 's2~1', 's3~1', 'm3~9'];
  const cap = 10;
  const out = planStrategyOneTargets(main, spec, domainOf, { cap, specialistSlots: 2 });
  const head = out.slice(0, cap);
  assert.ok(head.includes('m3~1'));
  assert.ok(!out.includes('m3~9'));
  assert.ok(head.includes('s1~1') && head.includes('s2~1'));
  assert.equal(new Set(out.map(domainOf)).size, out.length);
});

test('discovery script Strategy 1 is capped by strategyOneCap and uses the planner (source guard)', () => {
  const src = fs.readFileSync(new URL('../../scripts/discover-opening-night-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /planStrategyOneTargets\(/);
  assert.match(src, /strategyOneCalls >= strategyOneCap\(SERP_CALL_BUDGET\)/);
  assert.doesNotMatch(src, /outletIds\.push\(\.\.\.getLondonSupplementalOutlets/);
});
