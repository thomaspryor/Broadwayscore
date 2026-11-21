import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { splitBudgetBlockers, checkBudget } = require('./opening-night-budget.js');

const plenty = () => ({
  scrapingbee: { remaining: 5e6 }, brightdata: { remaining: 3000 },
  browserbase: { remaining: null }, anthropic: { remaining: null },
  openai: { remaining: null }, gemini: { remaining: null }, gha_minutes: { remaining: 2000 },
});

test('SB shortfall (BRO-7854 numbers) is soft, not hard', async () => {
  const u = plenty(); u.scrapingbee.remaining = 43571;
  const r = await checkBudget(1, { liveUsage: u });
  const { hard, soft } = splitBudgetBlockers(r.blockers);
  assert.equal(hard.length, 0);
  assert.equal(soft.length, 1);
  assert.equal(soft[0].resource, 'scrapingbee');
});

test('non-SB shortfall stays hard', async () => {
  const u = plenty(); u.brightdata.remaining = 10; u.scrapingbee.remaining = 100;
  const r = await checkBudget(1, { liveUsage: u });
  const { hard, soft } = splitBudgetBlockers(r.blockers);
  assert.deepEqual(hard.map(b => b.resource), ['brightdata']);
  assert.deepEqual(soft.map(b => b.resource), ['scrapingbee']);
});

test('readiness script routes through splitBudgetBlockers', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../check-opening-night-readiness.js', import.meta.url), 'utf8');
  assert.match(src, /splitBudgetBlockers\(budget\.blockers\)/);
});
