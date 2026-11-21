// BRO-7524: experiment scripts must enforce --max-cost and dedupe repeated calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('../lib/experiment-guard.js');

test('parseMaxCost: flag, alias, default, and refusal of unbounded values', () => {
  assert.equal(g.parseMaxCost(['--max-cost=5'], 10), 5);
  assert.equal(g.parseMaxCost(['--max-usd=7.5'], 10), 7.5);
  assert.equal(g.parseMaxCost([], 10), 10);
  for (const bad of ['0', '-1', 'unlimited', '']) assert.throws(() => g.parseMaxCost([`--max-cost=${bad}`], 10));
  assert.throws(() => g.parseMaxCost([], 0));
});

test('spend guard throws once the cap is reached', () => {
  const s = g.createSpendGuard(1);
  s.add(0.6); s.assertRoom();
  s.add(0.5);
  assert.equal(s.exceeded(), true);
  assert.throws(() => s.assertRoom(), g.BudgetExceeded);
});

test('call memo runs identical calls once, retries failures', async () => {
  const memo = g.createCallMemo();
  let n = 0;
  const k = g.callKey('m', 'prompt');
  await Promise.all([memo(k, async () => ++n), memo(k, async () => ++n), memo(k, async () => ++n)]);
  assert.equal(n, 1);
  let f = 0;
  await assert.rejects(memo('x', async () => { f++; throw new Error('boom'); }));
  await new Promise((r) => setImmediate(r));
  await memo('x', async () => { f++; return 1; });
  assert.equal(f, 2);
});

test('experiment scripts are wired to the guard (class guard: reverting the wiring fails)', () => {
  const fc = fs.readFileSync(new URL('../fact-check-historical-sample.js', import.meta.url), 'utf8');
  const sh = fs.readFileSync(new URL('../llm-scoring/openai-leg-shadow.ts', import.meta.url), 'utf8');
  for (const [name, src] of [['fact-check', fc], ['shadow', sh]]) {
    assert.match(src, /experiment-guard/, `${name} must require experiment-guard`);
    assert.match(src, /parseMaxCost\(/, `${name} must parse --max-cost`);
    assert.match(src, /assertRoom\(|exceeded\(|spentTotal\(\) >= maxCost/, `${name} must enforce the cap`);
  }
  assert.match(fc, /createCallMemo\(/);
  assert.equal((fc.match(/rethrowBudget\(await Promise\.allSettled/g) || []).length, 3, 'every allSettled must rethrow BudgetExceeded');
  assert.match(sh, /capHit/);
  assert.doesNotMatch(sh, /maxCost = [^;]*Infinity/, 'shadow cap must never default to unlimited');
});

test('cost.ts prices: haiku 4.5 and gpt-5.6-sol match vendor list', () => {
  const src = fs.readFileSync(new URL('../llm-scoring/cost.ts', import.meta.url), 'utf8');
  assert.match(src, /'claude-haiku':\s*\{ input: 1\.00, output: 5\.00 \}/);
  assert.match(src, /'openai-gpt56-sol':\s*\{ input: 4\.00, output: 20\.00 \}/);
});

test('retired Reddit hourly cron is gone', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/reddit-engagement-digest.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(y, /^\s*-\s*cron:/m);
});
