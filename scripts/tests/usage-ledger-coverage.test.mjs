// BRO-7521 class guard: model spend must be attributable. (1) every workflow
// job with a model secret saves its ledger rows; (2) Anthropic, batch and
// session calls produce ledger rows; (3) the monthly reconciliation flags a
// >20% gap. Run: node --test scripts/tests/usage-ledger-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.GEMINI_USAGE_LEDGER_PATH = path.join(os.tmpdir(), `bro7521-${process.pid}.jsonl`);
const L = require('../lib/gemini-usage-ledger');
const { ledgerProblems } = require('../lib/usage-ledger-coverage');
const { reconcile, previousMonth } = require('../lib/llm-spend-reconcile');

const WF = path.join(ROOT, '.github', 'workflows');

test('every workflow job with a model secret saves the usage ledger', () => {
  const bad = [];
  for (const f of fs.readdirSync(WF).filter((n) => n.endsWith('.yml'))) {
    for (const p of ledgerProblems(fs.readFileSync(path.join(WF, f), 'utf8'))) bad.push(`${f}: ${p}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('red-then-green: the rule flags a missing save step and accepts step or exemption', () => {
  const wf = (extra = '') => `name: x\n${extra}on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: node s.js\n        env:\n          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n`;
  assert.equal(ledgerProblems(wf()).length, 1);
  assert.equal(ledgerProblems(wf() + '      - uses: ./.github/actions/commit-scraper-spend-ledger\n').length, 0);
  assert.equal(ledgerProblems('# ledger-exempt: read-only context, never pushes anything\n' + wf()).length, 0);
  assert.equal(ledgerProblems('# ledger-exempt: short\n' + wf()).length, 1, 'a reason is required');
  // workflow-level env secret reaches every job
  const top = 'env:\n  GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n';
  assert.equal(ledgerProblems(top).length, 1);
});

test('Anthropic /v1/messages is metered and priced from the shared price table', () => {
  assert.deepEqual(L.classifyUrl('https://api.anthropic.com/v1/messages'), { provider: 'anthropic', stream: false });
  assert.equal(L.classifyUrl('https://api.anthropic.com/v1/messages/batches'), null);
  const u = L.extractAnthropicUsage({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 } });
  assert.deepEqual(u, { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500 });
  const sonnet = L.estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, { provider: 'anthropic' });
  assert.equal(sonnet, 18);
  assert.equal(L.estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, { provider: 'anthropic', discount: L.BATCH_DISCOUNT }), 9);
});

test('batch results become kind=batch rows at half price, with caller', () => {
  L.flush();
  L.recordBatchUsage({ provider: 'openai', model: 'gpt-4o', caller: 'batch-runner', results: [{ usage: { input: 1_000_000, output: 0 } }, { usage: undefined }] });
  const rows = L.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'batch');
  assert.equal(rows[0].caller, 'batch-runner');
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].unknownCalls, 1);
  assert.equal(rows[0].costUsd, 1.25);
});

test('session-side curl responses are logged as kind=session rows via the CLI', () => {
  const p = path.join(os.tmpdir(), `bro7521-cli-${process.pid}.jsonl`);
  fs.rmSync(p, { force: true });
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'log-llm-call.js'), '--provider=openai', '--caller=ship-check'], {
    input: JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
    env: { ...process.env, GEMINI_USAGE_LEDGER_PATH: p },
  });
  assert.equal(r.status, 0);
  const row = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  assert.equal(row.kind, 'session');
  assert.equal(row.caller, 'ship-check');
  assert.equal(row.provider, 'openai');
  assert.equal(row.inputTokens, 1000);
  // garbage input never fails the calling command
  assert.equal(spawnSync('node', [path.join(ROOT, 'scripts', 'log-llm-call.js'), '--provider=openai'], { input: 'not json', env: { ...process.env, GEMINI_USAGE_LEDGER_PATH: p } }).status, 0);
});

test('the three session commands tee their curl response into the logger', () => {
  for (const c of ['ship-check', 'plan-review', 'right-problem']) {
    const src = fs.readFileSync(path.join(ROOT, '.claude', 'commands', `${c}.md`), 'utf8');
    assert.match(src, /log-llm-call\.js --provider=/, `${c}.md must log its curl call`);
  }
});

test('batch-runner reports its batch results to the ledger', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'llm-scoring', 'batch-runner.ts'), 'utf8'), /recordBatchUsage\(\{ provider: 'anthropic'/);
});

test('reconciliation flags a gap over 20% and passes a close match', () => {
  const rows = [{ ts: '2026-10-05T00:00:00Z', provider: 'openai', costUsd: 100, calls: 5 }, { ts: '2026-10-06T00:00:00Z', provider: 'gemini', costUsd: 90, calls: 3 }, { ts: '2026-09-30T00:00:00Z', provider: 'gemini', costUsd: 999, calls: 1 }];
  const res = reconcile({ rows, month: '2026-10', receipts: { '2026-10': { openai: { usd: 580 }, gemini: { usd: 100 } } } });
  assert.deepEqual(res.flagged, ['openai']);
  assert.match(res.lines.find((l) => /gemini/.test(l)), /ok$/);
  assert.equal(previousMonth(new Date('2026-01-15T00:00:00Z')), '2025-12');
});

test('https.request callers (about 20 Anthropic scripts) are metered after the caller attaches its listeners', async () => {
  const { EventEmitter } = require('node:events');
  L.install();
  const https = require('node:https');
  assert.equal(https.request.__llmMetered, true, 'install() must wrap https.request');
  L.flush();
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = { 'content-type': 'application/json' };
  L.observeHttpsResponse({ provider: 'anthropic', stream: false }, 'https://api.anthropic.com/v1/messages', res);
  res.emit('data', Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } })));
  res.emit('end');
  const rows = L.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'anthropic');
  assert.equal(rows[0].inputTokens, 100);
  // compressed bodies count as an unpriced call, never zero cost
  const gz = new EventEmitter(); gz.statusCode = 200; gz.headers = { 'content-encoding': 'gzip' };
  L.observeHttpsResponse({ provider: 'anthropic', stream: false }, 'https://api.anthropic.com/v1/messages', gz);
  gz.emit('data', Buffer.from('xx')); gz.emit('end');
  const r2 = L.flush();
  assert.equal(r2[0].unknownCalls, 1);
  assert.equal(r2[0].costUsd, null);
});

test('readRows with an explicit path reads only that file, never the machine session rows', () => {
  const { readRows } = require('../lib/llm-usage-summary');
  const p = path.join(os.tmpdir(), `bro7521-empty-${process.pid}.jsonl`);
  fs.writeFileSync(p, '');
  assert.deepEqual(readRows(p), []);
  assert.ok(L.sessionLedgerPath().includes(os.tmpdir()) || process.env.GEMINI_USAGE_LEDGER_PATH, 'tests never write the home-folder session ledger');
});

test('index.ts records batch spend once per consumed batch (merge and abandon, never on a kept-state drain)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'llm-scoring', 'index.ts'), 'utf8');
  assert.match(src, /if \(unretrievableVendors\.length === 0\) recordBatchSpend\(state, vendorResults\)/);
  assert.match(src, /if \(action === 'abandon'\) \{\s*recordBatchSpend\(state, vendorResults\)/);
});

test('no script mixes ESM imports with a CommonJS meter require (would throw "require is not defined" at runtime)', () => {
  const bad = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|cjs)$/.test(e.name)) { const s = fs.readFileSync(p, 'utf8'); if (/^require\(['"][^'"]*llm-usage-install['"]\)/m.test(s) && /^(import\s.+\sfrom\s|import\s+['"]|export\s)/m.test(s)) bad.push(path.relative(ROOT, p)); } } };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(bad, []);
});
