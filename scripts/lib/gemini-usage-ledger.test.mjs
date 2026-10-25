// BRO-5043: requires the real ledger helper (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./gemini-usage-ledger.js');

test('a call records workflow, model, tokens and cost', () => {
  const usage = L.extractUsage({ usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 100000, thoughtsTokenCount: 100000 } });
  assert.deepEqual(usage, { inputTokens: 1000000, outputTokens: 200000 });
  const agg = new Map([['gemini-2.5-pro', { calls: 1, unknownCalls: 0, inputTokens: 1000000, outputTokens: 200000 }]]);
  const [row] = L.buildRows(agg, { workflow: 'enrich-reviews', script: 'x.js', now: new Date('2026-10-11T00:00:00Z') });
  assert.equal(row.workflow, 'enrich-reviews');
  assert.equal(row.model, 'gemini-2.5-pro');
  assert.equal(row.inputTokens, 1000000);
  assert.equal(row.costUsd, 3.25); // 1.25 + 0.2*10
});

test('missing usageMetadata records tokens as unknown, not zero', () => {
  assert.equal(L.extractUsage({}), null);
  const agg = new Map([['gemini-2.5-pro', { calls: 2, unknownCalls: 2, inputTokens: 0, outputTokens: 0 }]]);
  const [row] = L.buildRows(agg, { workflow: 'w', script: 's' });
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(row.costUsd, null);
  assert.equal(row.calls, 2);
});

test('unknown model has unknown cost', () => {
  assert.equal(L.estimateCostUsd('mystery', 10, 10), null);
  assert.equal(L.modelFromUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=x'), 'gemini-2.5-pro');
});

test('install() observes a Gemini fetch without altering the response, and flush writes a row', async () => {
  const p = path.join(os.tmpdir(), `gul-${process.pid}.jsonl`);
  process.env.GEMINI_USAGE_LEDGER_PATH = p;
  const body = { candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  L.install();
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=k');
  assert.deepEqual(await res.json(), body); // caller still reads its own body
  const rows = L.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 10);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8').trim()).outputTokens, 5);
  fs.unlinkSync(p);
});

test('non-Gemini URLs and clone-less mock responses pass through untouched', async () => {
  const plain = { ok: true, json: async () => ({}) };
  globalThis[Symbol.for('bsc.geminiUsage')] = false;
  globalThis.fetch = async () => plain;
  L.install();
  assert.equal(await fetch('https://example.com/x'), plain);
  assert.equal(await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'), plain);
  assert.equal(await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:batchGenerateContent'), plain);
  assert.deepEqual(L.flush(), []);
});
