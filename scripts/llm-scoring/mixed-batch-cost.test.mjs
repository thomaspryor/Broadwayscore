// BRO-5047: a --batch run that also scores urgent reviews synchronously must
// price that sync share at full rate (costBreakdown(batch:true) halved it).
// require('ts-node/register') mirrors cost-recording.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register');
const { costBreakdown, mixedCostBreakdown, subtractUsage, addUsage } = require('./cost');

const usage = (n) => ({
  claude: { input: 1_000_000 * n, output: 100_000 * n, cacheWrite: 0, cacheRead: 0 },
  openai: { input: 1_000_000 * n, output: 100_000 * n },
  gemini: { input: 1_000_000 * n, output: 100_000 * n },
});

test('all-batch run: same as costBreakdown(batch:true)', () => {
  const t = usage(2);
  assert.ok(Math.abs(mixedCostBreakdown(t, null).total - costBreakdown(t, { batch: true }).total) < 1e-9);
});

test('mixed run: sync share at full rate, rest at batch rate', () => {
  const total = usage(3);
  const sync = usage(1);
  const got = mixedCostBreakdown(total, sync).total;
  const want = costBreakdown(usage(2), { batch: true }).total + costBreakdown(usage(1), { batch: false }).total;
  assert.ok(Math.abs(got - want) < 1e-9);
  assert.ok(got > costBreakdown(total, { batch: true }).total, 'must cost more than pricing everything at batch rate');
});

test('addUsage / subtractUsage are field-wise and floor at zero', () => {
  const a = addUsage(null, usage(1));
  const b = addUsage(a, usage(1));
  assert.equal(b.openai.input, 2_000_000);
  assert.equal(subtractUsage(usage(1), usage(2)).claude.input, 0);
  assert.equal(subtractUsage(usage(2), null).gemini.output, 200_000);
});
