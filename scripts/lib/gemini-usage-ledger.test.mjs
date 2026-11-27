// BRO-5043: requires the real ledger helper (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./gemini-usage-ledger.js');

test('reviewer metered calls are folded as session spend', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8356-'));
  const from = path.join(dir, 'session.jsonl');
  const to = path.join(dir, 'tracked.jsonl');
  const previous = process.env.GEMINI_USAGE_LEDGER_PATH;
  try {
    process.env.GEMINI_USAGE_LEDGER_PATH = from;
    L.setSessionUsageCaller('ship-check');
    L.recordUsage({ model: 'gemini-2.5-pro', usage: { inputTokens: 1000, outputTokens: 100 } });
    const [row] = L.flush();
    assert.equal(row.kind, 'session');
    assert.equal(row.caller, 'ship-check');
    delete process.env.GEMINI_USAGE_LEDGER_PATH;
    assert.equal(L.foldSessionRows({ from, to }), 1);
    assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).costUsd, row.costUsd);
  } finally {
    L.setSessionUsageCaller(null);
    if (previous === undefined) delete process.env.GEMINI_USAGE_LEDGER_PATH; else process.env.GEMINI_USAGE_LEDGER_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  await L.settle();
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

// Owner asked 2026-11-08 to explain and cut the Gemini + OpenAI bill: the
// meter now covers OpenAI, grounded/search calls, cached input and repeats.
test('OpenAI chat and Responses usage price from the shared rate table, cached input at the cached rate', () => {
  const chat = L.extractOpenAIUsage({ usage: { prompt_tokens: 1000000, completion_tokens: 100000, prompt_tokens_details: { cached_tokens: 400000 } } });
  assert.deepEqual(chat, { inputTokens: 1000000, outputTokens: 100000, cachedInputTokens: 400000 });
  // gpt-4o: 600k*2.50 + 400k*1.25 + 100k*10 = 1.5 + 0.5 + 1.0
  assert.equal(L.estimateCostUsd('gpt-4o-2024-08-06', 1000000, 100000, { provider: 'openai', cachedInputTokens: 400000 }), 3);
  const resp = L.extractOpenAIUsage({ usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } });
  assert.deepEqual(resp, { inputTokens: 10, outputTokens: 5 });
  assert.equal(L.openaiSearchCalls({ output: [{ type: 'web_search_call' }, { type: 'message' }, { type: 'web_search_call' }] }), 2);
  assert.equal(L.estimateCostUsd('gpt-6-astra', 10, 10, { provider: 'openai' }), null, 'unknown model stays unknown');
  assert.equal(L.extractOpenAIUsage({}), null);
});

test('Gemini grounding is detected and priced per call; cached prompt tokens bill at a quarter', () => {
  assert.equal(L.geminiGrounded({ candidates: [{ groundingMetadata: { webSearchQueries: ['q'] } }] }), true);
  assert.equal(L.geminiGrounded({ candidates: [{ content: {} }] }), false);
  const u = L.extractUsage({ usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 0, cachedContentTokenCount: 1000000 } });
  assert.equal(u.cachedInputTokens, 1000000);
  // pro: 1M cached * 1.25 * 0.25 = 0.3125, plus one grounded prompt 0.035
  assert.equal(L.estimateCostUsd('gemini-2.5-pro', 1000000, 0, { cachedInputTokens: 1000000, groundedCalls: 1 }), 0.3475);
});

test('classifyUrl meters generate/chat/responses/embeddings and skips batch, files and models', () => {
  const g = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro';
  assert.deepEqual(L.classifyUrl(`${g}:generateContent?key=k`), { provider: 'gemini', stream: false });
  assert.deepEqual(L.classifyUrl(`${g}:streamGenerateContent?alt=sse&key=k`), { provider: 'gemini', stream: true });
  assert.equal(L.classifyUrl(`${g}:batchGenerateContent`), null);
  assert.equal(L.classifyUrl(`${g}:countTokens`), null);
  for (const p of ['chat/completions', 'responses', 'embeddings']) assert.equal(L.classifyUrl(`https://api.openai.com/v1/${p}`).provider, 'openai');
  assert.equal(L.classifyUrl('https://api.openai.com/v1/batches'), null);
  assert.equal(L.classifyUrl('https://api.openai.com/v1/files'), null);
  assert.equal(L.classifyUrl('https://example.com/v1/responses'), null);
});

test('requestHash ignores the API key, hashes only string bodies, and caps huge bodies', () => {
  const a = L.requestHash('https://h/m:generateContent?key=AAA', { body: '{"x":1}' });
  const b = L.requestHash('https://h/m:generateContent?key=BBB', { body: '{"x":1}' });
  assert.equal(a, b);
  assert.notEqual(a, L.requestHash('https://h/m:generateContent?key=AAA', { body: '{"x":2}' }));
  assert.equal(L.requestHash('https://h', { body: new Uint8Array(3) }), null);
  assert.equal(L.requestHash('https://h', {}), null);
  const big = 'x'.repeat(2 * 1024 * 1024);
  assert.notEqual(L.requestHash('https://h', { body: big }), L.requestHash('https://h', { body: big + 'y' }), 'length is part of the capped hash');
});

test('install() records OpenAI, grounding and repeats per (provider, model) in one flush', async () => {
  const p = path.join(os.tmpdir(), `gul-oa-${process.pid}.jsonl`);
  process.env.GEMINI_USAGE_LEDGER_PATH = p;
  globalThis[Symbol.for('bsc.geminiUsage')] = false;
  L.flush();
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (String(url).includes('openai')) return json({ model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 10 } });
    return json({ candidates: [{ groundingMetadata: { webSearchQueries: ['a'] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  };
  L.install();
  const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [] });
  await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body });
  await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body });
  const gres = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=k', { method: 'POST', body: '{}' });
  assert.equal((await gres.json()).usageMetadata.promptTokenCount, 10, 'caller still reads its own body');
  await L.settle();
  const rows = L.flush();
  const oa = rows.find((r) => r.provider === 'openai');
  const gm = rows.find((r) => r.provider === 'gemini');
  assert.equal(oa.model, 'gpt-4o-mini');
  assert.equal(oa.calls, 2);
  assert.equal(oa.dupCalls, 1);
  assert.equal(oa.inputTokens, 200);
  assert.equal(gm.groundedCalls, 1);
  assert.ok(gm.costUsd > 0.035, 'grounding fee is in the cost');
  assert.ok(!JSON.stringify(rows).includes('key='), 'never records the URL');
  fs.unlinkSync(p);
});

test('streaming calls count as unknown, never as zero tokens', async () => {
  globalThis[Symbol.for('bsc.geminiUsage')] = false;
  L.flush();
  globalThis.fetch = async () => new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  L.install();
  await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=k', { method: 'POST', body: '{}' });
  const [row] = L.flush();
  assert.equal(row.calls, 1);
  assert.equal(row.unknownCalls, 1);
  assert.equal(row.costUsd, null);
});

test('fetch resolves when headers arrive, not after the meter reads the body (openai SDK timeout unchanged)', async () => {
  globalThis[Symbol.for('bsc.geminiUsage')] = false;
  L.flush();
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { setTimeout(() => { c.enqueue(enc.encode(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1, completion_tokens: 1 } }))); c.close(); }, 300); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  L.install();
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"gpt-4o-mini"}' });
  assert.ok(Date.now() - t0 < 150, `fetch waited ${Date.now() - t0}ms for the body`);
  assert.equal((await res.json()).model, 'gpt-4o-mini');
  await L.settle();
  const [row] = L.flush();
  assert.equal(row.calls, 1);
  assert.equal(row.inputTokens, 1);
});

// BRO-8016 class guard: a new Gemini pin in models.js with no PRICES_PER_M row logs every call with
// costUsd null, so the spend ledger silently stops counting it. Every Gemini pin must price.
test('every Gemini pin in models.js has a price row', () => {
  const models = require('./models.js');
  const unpriced = Object.entries(models).filter(([, id]) => /^gemini-/.test(id) && L.estimateCostUsd(id, 1e6, 1e6) === null).map(([k, id]) => `${k}=${id}`);
  assert.deepEqual(unpriced, [], `add a PRICES_PER_M row in gemini-usage-ledger.js: ${unpriced.join(', ')}`);
  assert.equal(L.estimateCostUsd(models.GEMINI_REVIEW, 1e6, 1e6), 9); // gemini-3.8-flash (BRO-8108)
  assert.equal(L.estimateCostUsd('gemini-4-carbon', 1e6, 1e6), 24); // old rows still price
});

// BRO-8108: a cloud session's home folder dies with its container, so session rows (every
// /ship-check Gemini review) never reached any ledger and a ~$190/day bill read as ~$5.
// In-session writes stay in the home file (a tracked write tripped review.js's tree tripwire
// when reviewers ran in parallel); wrap-up folds them into the tracked file.
test('cloud sessions still write the home file during the session (no tracked-tree writes)', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8108-'));
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).sessionLedgerPath())', require.resolve('./gemini-usage-ledger.js')],
    { env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_REMOTE: 'true' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, path.join(home, '.claude', 'state', 'llm-session-usage.jsonl'));
  const attrs = fs.readFileSync(path.join(path.dirname(require.resolve('./gemini-usage-ledger.js')), '..', '..', '.gitattributes'), 'utf8');
  assert.match(attrs, /^data\/audit\/llm-session-usage\.jsonl merge=union$/m);
});

test('foldSessionRows copies new session rows once into the tracked ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8108-fold-'));
  const from = path.join(dir, 'home.jsonl');
  const to = path.join(dir, 'repo', 'data', 'audit', 'llm-session-usage.jsonl');
  const a = JSON.stringify({ ts: '2026-11-23T00:00:00Z', provider: 'gemini', kind: 'session', model: 'gemini-3.8-flash', costUsd: 0.13 });
  const b = JSON.stringify({ ts: '2026-11-23T00:01:00Z', provider: 'openai', kind: 'session', model: 'gpt-x', costUsd: 0.01 });
  fs.writeFileSync(from, a + '\nnot json\n' + b + '\n');
  assert.equal(L.foldSessionRows({ from, to }), 2);
  assert.equal(L.foldSessionRows({ from, to }), 0, 'a second wrap-up adds nothing');
  assert.deepEqual(fs.readFileSync(to, 'utf8').trim().split('\n'), [a, b]);
  assert.equal(L.foldSessionRows({ from: path.join(dir, 'missing.jsonl'), to }), 0);
  assert.equal(L.foldSessionRows({ from: to, to }), 0, 'same file is a no-op');
});

test('the usage summary reads committed cloud-session rows', () => {
  const S = require('./llm-usage-summary.js');
  const src = fs.readFileSync(require.resolve('./llm-usage-summary.js'), 'utf8');
  assert.match(src, /TRACKED_SESSION_LEDGER_PATH/);
  assert.equal(typeof S.readRows, 'function');
});

test('mergeRowSets: a session row in the tracked file and the home file counts once; API rows never merge', () => {
  const { mergeRowSets } = require('./llm-usage-summary.js');
  const sess = { ts: '2026-11-23T00:00:00.000Z', provider: 'gemini', kind: 'session', caller: 'ship-check', costUsd: 0.5 };
  const api = { ts: '2026-11-23T00:00:00.000Z', provider: 'gemini', kind: 'api', script: 'x.js', costUsd: 0.1 };
  const base = [api, { ...api }];
  const tracked = [sess, { ...sess }]; // a union merge of two branches that folded the same row
  const home = [{ ...sess }];
  const out = mergeRowSets([base, tracked, home]);
  assert.equal(out.filter((r) => r.kind === 'session').length, 1);
  assert.equal(out.filter((r) => r.kind === 'api').length, 2, 'identical API flushes are real spend');
});

test('foldSessionRows copies only session rows and never folds the main ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8108-only-'));
  const from = path.join(dir, 'home.jsonl');
  const to = path.join(dir, 'tracked.jsonl');
  const sess = JSON.stringify({ kind: 'session', caller: 'ship-check', costUsd: 0.2 });
  fs.writeFileSync(from, JSON.stringify({ kind: 'api', script: 'ci.js' }) + '\n' + sess + '\n');
  assert.equal(L.foldSessionRows({ from, to }), 1);
  assert.equal(fs.readFileSync(to, 'utf8'), sess + '\n');
  // A fixture main ledger (never the real bot ledger: live-data-lane, BRO-8108).
  const main = path.join(dir, 'main-ledger.jsonl');
  fs.writeFileSync(main, sess + '\n');
  const prev = process.env.GEMINI_USAGE_LEDGER_PATH;
  process.env.GEMINI_USAGE_LEDGER_PATH = main;
  try {
    assert.equal(L.foldSessionRows({ from: main, to: path.join(dir, 't2.jsonl') }), 0, 'the main ledger is never folded');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_USAGE_LEDGER_PATH; else process.env.GEMINI_USAGE_LEDGER_PATH = prev;
  }
  assert.equal(fs.existsSync(path.join(dir, 't2.jsonl')), false);
  fs.mkdirSync(path.join(dir, 'adir.jsonl'));
  assert.throws(() => L.foldSessionRows({ from: path.join(dir, 'adir.jsonl'), to }), 'an unreadable source is an error, not "nothing to fold"');
});

test('foldSessionRows: no glued rows without a final newline, CRLF rows still dedupe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8108-nl-'));
  const from = path.join(dir, 'home.jsonl'); const to = path.join(dir, 'tracked.jsonl');
  const a = JSON.stringify({ kind: 'session', n: 1 }); const b = JSON.stringify({ kind: 'session', n: 2 });
  fs.writeFileSync(to, a); // no trailing newline
  fs.writeFileSync(from, a + '\r\n' + b + '\r\n');
  assert.equal(L.foldSessionRows({ from, to }), 1, 'the CRLF copy of a is already there');
  assert.deepEqual(fs.readFileSync(to, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).n), [1, 2]);
});

test('the Gemini CLI helper model is priced', () => {
  assert.notEqual(L.estimateCostUsd('gemini-3-flash-preview', 1e6, 1e6), null);
});

// BRO-8356: pre-a6d3bb4 reviewer rows were written as kind 'api' to the home file, so the
// fold dropped them and main had no reviewer spend for 2026-11-24..26.
test('foldSessionRows folds legacy reviewer api rows as session rows, once; summary counts them once', () => {
  const { mergeRowSets } = require('./llm-usage-summary.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8356-legacy-'));
  const from = path.join(dir, 'home.jsonl');
  const to = path.join(dir, 'tracked.jsonl');
  try {
    const legacy = { ts: '2026-11-25T01:20:00.000Z', provider: 'gemini', workflow: 'local', script: 'scripts/gemini/review.js', kind: 'api', caller: 'scripts/gemini/review.js', model: 'gemini-3.8-flash', costUsd: 0.2 };
    const skeptic = { ts: '2026-11-25T01:21:00.000Z', provider: 'openai', script: 'scripts/lib/skeptic-review-stop.mjs', kind: 'api', caller: null, costUsd: 0.01 };
    const ci = { ts: '2026-11-25T01:22:00.000Z', provider: 'gemini', script: 'scripts/some-ci-job.js', kind: 'api', costUsd: 9 };
    fs.writeFileSync(from, [legacy, skeptic, ci].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(L.foldSessionRows({ from, to }), 2, 'both reviewer rows fold, the CI api row does not');
    assert.equal(L.foldSessionRows({ from, to }), 0, 'a second fold adds nothing');
    const tracked = fs.readFileSync(to, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(tracked.map((r) => r.kind), ['session', 'session']);
    assert.equal(tracked[1].caller, 'scripts/lib/skeptic-review-stop.mjs');
    const home = fs.readFileSync(from, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const merged = mergeRowSets([tracked, home]);
    const usd = merged.reduce((s, r) => s + r.costUsd, 0);
    assert.equal(Math.round(usd * 100) / 100, 9.21, 'the folded copy and its home original count once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
