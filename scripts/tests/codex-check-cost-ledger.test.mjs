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
  assert.match(src, /arg\('check-max-usd', 4\)/);
  assert.match(src, /arg\('check-budget-usd', 10\)/);
});

// The scratch file crosses an artifact boundary: only allowlisted, bounded anthropic rows get in.
const M = require('../codex/merge-check-usage.js');
test('merge keeps real rows and drops forged or oversized ones', () => {
  const good = JSON.stringify(L.buildClaudeCheckRow({ model: 'opus', costUsd: 0.31, card: 'BRO-7', auth: 'api-key', runId: '12' }));
  const lines = [
    good,
    'not json',
    JSON.stringify({ provider: 'openai', ts: new Date().toISOString(), model: 'x', costUsd: 1 }),
    JSON.stringify({ provider: 'anthropic', ts: new Date().toISOString(), model: 'opus', costUsd: 9999 }),
    JSON.stringify({ provider: 'anthropic', ts: new Date().toISOString(), model: '../../etc', costUsd: 1 }),
    JSON.stringify({ provider: 'anthropic', ts: new Date().toISOString(), model: 'opus', costUsd: 1, evil: 'x', card: 'bad card' }),
  ].join('\n');
  const rows = M.sanitizeFile(lines);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].costUsd, 0.31);
  assert.equal(rows[1].card, undefined);
  assert.equal(rows[1].evil, undefined);
});

test('the workflow commits the ledger from a separate contents:write job, not the runner job', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/codex-runner.yml', import.meta.url), 'utf8');
  assert.match(y, /^permissions:\n {2}contents: read/m);
  assert.match(y, /usage-ledger:[\s\S]*permissions:\n {6}contents: write[\s\S]*merge-check-usage\.js/);
  assert.match(y, /CODEX_CHECK_USAGE_AUTH_PATH: \$\{\{ runner\.temp \}\}\/codex-check-usage\.jsonl/);
  assert.match(y, /usage-ledger:[\s\S]*ref: main/);
});

test('forged rows: old timestamps, other run ids and inflated totals are bounded; a re-run is not double counted', () => {
  const now = Date.now();
  const mk = (o) => JSON.stringify({ provider: 'anthropic', ts: new Date(now).toISOString(), model: 'opus', costUsd: 1, runId: '1', ...o });
  const old = mk({ ts: new Date(now - 30 * 3600_000).toISOString() });
  assert.equal(M.sanitizeRow(old, { nowMs: now, runId: '77' }), null);
  assert.equal(M.sanitizeRow(mk({}), { nowMs: now, runId: '77' }).runId, '77');
  const many = Array.from({ length: 100 }, () => mk({ costUsd: 20 })).join('\n');
  assert.ok(M.sanitizeFile(many, { runId: '77' }).length <= 2); // $40 total cap
  const ledger = JSON.stringify(M.sanitizeRow(mk({}), { nowMs: now, runId: '77' }));
  assert.equal(M.alreadyMerged(ledger, '77'), true);
  assert.equal(M.alreadyMerged(ledger, '78'), false);
});

test('the scratch path var is scrubbed from Codex and reviewer shells', () => {
  assert.equal(R.keepEnvVar('CODEX_CHECK_USAGE_AUTH_PATH'), false);
  assert.equal(R.keepEnvVar('CODEX_CHECK_USAGE_AUTH_PATH', { reviewer: true }), false);
});

test('a row with object-valued fields is dropped, not a crash', () => {
  const bad = '{"provider":"anthropic","ts":{"toString":null},"model":"opus","costUsd":{"valueOf":null}}';
  assert.equal(M.sanitizeRow(bad, { runId: '1' }), null);
  assert.deepEqual(M.sanitizeFile(bad + '\n' + bad, { runId: '1' }), []);
});
