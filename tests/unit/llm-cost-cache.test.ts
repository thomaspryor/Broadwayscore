/**
 * Cache-token pricing in scripts/llm-scoring/cost.ts.
 *
 * These multipliers gate the --max-cost budget circuit in llm-scoring/index.ts
 * (Phase B-WE W1-T5): a wrong coefficient loosens or tightens the budget
 * breaker silently. Tests require() the real module per CLAUDE.md rule 15.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  estimateCost,
  costBreakdown,
  COST_PER_MILLION_TOKENS,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
} from '../../scripts/llm-scoring/cost';

const M = 1_000_000;
const SONNET = COST_PER_MILLION_TOKENS['claude-sonnet'];

test('backward compatible: plain {input, output} usage prices as before', () => {
  const cost = estimateCost({ claude: { input: M, output: M } });
  assert.strictEqual(cost, SONNET.input + SONNET.output);
});

test('cache write bills at 1.25x claude input price', () => {
  assert.strictEqual(CACHE_WRITE_MULTIPLIER, 1.25);
  const cost = estimateCost({ claude: { input: 0, output: 0, cacheWrite: M, cacheRead: 0 } });
  assert.ok(Math.abs(cost - SONNET.input * 1.25) < 1e-9, `got ${cost}`);
});

test('cache read bills at 0.1x claude input price', () => {
  assert.strictEqual(CACHE_READ_MULTIPLIER, 0.1);
  const cost = estimateCost({ claude: { input: 0, output: 0, cacheWrite: 0, cacheRead: M } });
  assert.ok(Math.abs(cost - SONNET.input * 0.1) < 1e-9, `got ${cost}`);
});

test('haiku model name routes cache pricing to haiku input price', () => {
  const haiku = COST_PER_MILLION_TOKENS['claude-haiku'];
  const cost = estimateCost(
    { claude: { input: 0, output: 0, cacheWrite: M, cacheRead: M } },
    { claudeModelName: 'claude-haiku-4-5-20251001' }
  );
  assert.ok(Math.abs(cost - (haiku.input * 1.25 + haiku.input * 0.1)) < 1e-9, `got ${cost}`);
});

test('cached run is cheaper than the same tokens uncached', () => {
  // 3.6K-token system prompt over 100 reviews: uncached vs 1 write + 99 reads.
  const uncached = estimateCost({ claude: { input: 3600 * 100, output: 0 } });
  const cached = estimateCost({ claude: { input: 0, output: 0, cacheWrite: 3600, cacheRead: 3600 * 99 } });
  assert.ok(cached < uncached * 0.15, `cached=${cached} uncached=${uncached}`);
});

test('costBreakdown claude leg matches estimateCost for cache usage', () => {
  const usage = { claude: { input: 500_000, output: 100_000, cacheWrite: 300_000, cacheRead: 2_000_000 } };
  const b = costBreakdown(usage);
  assert.ok(Math.abs(b.claude - estimateCost(usage)) < 1e-9);
  assert.strictEqual(b.total, b.claude + b.openai + b.gemini + b.kimi);
});
