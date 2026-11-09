// BRO-5043: requires the real rollup (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('./llm-usage-summary.js');

const rows = [
  { ts: '2026-11-08T01:00:00Z', workflow: 'Old', script: 'a.js', model: 'gemini-2.5-flash', calls: 10, unknownCalls: 0, costUsd: 1 },
  { ts: '2026-11-08T02:00:00Z', provider: 'openai', workflow: 'W', script: 'scripts/b.js', model: 'gpt-4o', calls: 4, unknownCalls: 1, costUsd: 3, dupCalls: 2 },
  { ts: '2026-11-08T03:00:00Z', provider: 'gemini', workflow: 'W', script: 'scripts/c.js', model: 'gemini-2.5-pro', calls: 2, unknownCalls: 0, costUsd: 0.5, groundedCalls: 2 },
  { ts: '2026-11-07T23:59:59Z', provider: 'gemini', workflow: 'X', script: 'd.js', model: 'gemini-2.5-flash', calls: 1, unknownCalls: 0, costUsd: 99 },
];

test('rows without a provider are Gemini, and totals split by provider', () => {
  const s = S.summarize(rows, { fromMs: Date.parse('2026-11-08T00:00:00Z') });
  assert.equal(s.providers.gemini.usd, 1.5);
  assert.equal(s.providers.gemini.groundedCalls, 2);
  assert.equal(s.providers.openai.usd, 3);
  assert.equal(s.providers.openai.dupCalls, 2);
  assert.equal(s.callers[0].script, 'scripts/b.js', 'callers sorted by cost');
});

test('digestTitle covers one UTC day only and names the top callers', () => {
  const t = S.digestTitle(rows, '2026-11-08');
  assert.match(t, /^2026-11-08 · LLM APIs \(metered estimate, not the full bill\): Gemini est \$1\.50 \(12 calls; 2 search-grounded\) · OpenAI est \$3\.00 \(4 calls; 2 repeats, 1 unpriced\)/);
  assert.match(t, /top: scripts\/b\.js \[W\] \$3\.00; a\.js \[Old\] \$1\.00; scripts\/c\.js \[W\] \$0\.50$/);
  assert.ok(!t.includes('99'), 'the previous day is excluded');
  assert.equal(S.digestTitle(rows, '2026-01-01'), null);
});

test('readRows tolerates a missing file and corrupt lines', () => {
  assert.deepEqual(S.readRows('/nonexistent/ledger.jsonl'), []);
});
