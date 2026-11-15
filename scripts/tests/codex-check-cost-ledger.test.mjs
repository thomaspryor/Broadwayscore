// BRO-7522: the Codex runner's metered `claude -p` check lands in the usage ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../lib/gemini-usage-ledger.js');
const S = require('../lib/llm-usage-summary.js');
const R = require('../lib/codex-runner.js');

test('the claude -p JSON cost becomes an anthropic ledger row', () => {
  const out = R.parseCheckOutput(JSON.stringify({ result: 'SHIP', total_cost_usd: 0.67, is_error: false }));
  const row = L.buildClaudeCheckRow({ model: 'opus', costUsd: out.costUsd, card: 'BRO-1', auth: 'api-key', now: new Date('2026-11-15T00:00:00Z'), workflow: 'Codex card runner', runId: '9' });
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.costUsd, 0.67);
  assert.equal(row.auth, 'api-key');
  assert.equal(row.card, 'BRO-1');
  assert.equal(row.calls, 1);
});

test('recordClaudeCheck appends a row and the summary counts it as Claude spend', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'l.jsonl');
  process.env.GEMINI_USAGE_LEDGER_PATH = p;
  try {
    L.recordClaudeCheck({ model: 'sonnet', costUsd: 0.05, workflow: 'Codex card runner', auth: 'api-key' });
    L.recordClaudeCheck({ model: 'opus', costUsd: 0.2, error: 'error_max_budget_usd', workflow: 'Codex card runner', auth: 'api-key' });
    const rows = S.readRows(p);
    assert.equal(rows.length, 2);
    const s = S.summarize(rows);
    assert.ok(Math.abs(s.providers.anthropic.usd - 0.25) < 1e-9);
    assert.match(S.digestTitle(rows, rows[0].ts.slice(0, 10)), /Claude est \$0\.25 \(2 calls\)/);
  } finally { delete process.env.GEMINI_USAGE_LEDGER_PATH; }
});

test('an unreadable cost is null, never zero', () => {
  assert.equal(L.buildClaudeCheckRow({ model: 'opus', costUsd: NaN, auth: 'oauth' }).costUsd, null);
});

test('the runner records every check and keeps the measured-safe caps', () => {
  const src = fs.readFileSync(new URL('../codex/daily-runner.js', import.meta.url), 'utf8');
  assert.match(src, /recordClaudeCheck\(\{ model, costUsd: out\.costUsd/);
  assert.match(src, /arg\('check-max-usd', 2\)/);
  assert.match(src, /arg\('check-budget-usd', 10\)/);
});
