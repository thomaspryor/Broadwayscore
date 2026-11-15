// BRO-7523: the scheduled rescore drain and comparative-rescore must run through the
// vendor Batch APIs (50%), with sync kept for opening-night/manual dispatches.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cb = require('../lib/comparative-batch.js');
const { openaiChatBody } = require('../lib/llm-batch.js');

const wf = fs.readFileSync(new URL('../../.github/workflows/llm-ensemble-score.yml', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../llm-scoring/comparative-core.ts', import.meta.url), 'utf8');

function stepBody(name) {
  const start = wf.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step not found: ${name}`);
  const next = wf.indexOf('\n      - name:', start + 10);
  return wf.slice(start, next > 0 ? next : undefined);
}

test('nightly needsRescore drain passes --batch unless DISABLE_BATCH_SCORING=1', () => {
  const s = stepBody('Drain needsRescore backlog (capped, scheduled only)');
  assert.match(s, /--batch --batch-poll-minutes=\d+/);
  assert.match(s, /DISABLE_BATCH_SCORING/);
  assert.match(s, /index\.ts[^\n]*\$DRAIN_BATCH/);
});

test('comparative-rescore invocations carry the batch flag on scheduled runs only', () => {
  const s = stepBody('Comparative within-band rescore (WE/OWE anchored-v6, capped)');
  const calls = s.split('\n').filter((l) => l.includes('comparative-rescore.ts') && l.includes('npx'));
  assert.ok(calls.length >= 2);
  for (const l of calls) assert.match(l, /\$CMP_BATCH/, l);
  assert.match(s, /event_name \}\}" == "schedule"/);
  assert.match(s, /DISABLE_BATCH_SCORING/);
  assert.match(s, /chain/);
});

test('resumableBatch: same prompts + <24h resumes; changed prompts or stale state does not', () => {
  const h = cb.promptSetHash(['a', 'b']);
  const now = Date.parse('2026-11-15T12:00:00Z');
  const st = { claude: { id: 'msgbatch_1', hash: h, submittedAt: '2026-11-15T10:00:00Z' } };
  assert.equal(cb.resumableBatch(st, 'claude', h, now), 'msgbatch_1');
  assert.equal(cb.resumableBatch(st, 'claude', cb.promptSetHash(['a', 'c']), now), null);
  assert.equal(cb.resumableBatch(st, 'claude', h, now + 25 * 3600e3), null);
  assert.equal(cb.resumableBatch(st, 'openai', h, now), null);
});

test('allVendorsAnswered: a missing vendor answer blocks settling the group', () => {
  const ans = { openai: new Map([['p', 'x']]), gemini: new Map() };
  assert.equal(cb.allVendorsAnswered(ans, 'p'), false);
  ans.gemini.set('p', 'y');
  assert.equal(cb.allVendorsAnswered(ans, 'p'), true);
  assert.equal(cb.allVendorsAnswered({}, 'p'), false);
});

test('comparative-rescore never falls back to a sync call in batch mode', () => {
  const src = fs.readFileSync(new URL('../llm-scoring/comparative-rescore.ts', import.meta.url), 'utf8');
  assert.match(src, /activeModels = batchedModels\(models, answers\)/);
  assert.match(src, /activeModels = batchedModels\(models, \{\}\)/);
});

test('batch requests carry the same model/prompt/params as the sync callers', () => {
  const P = cb.COMPARATIVE_PARAMS;
  const a = cb.buildAnthropicRequest(3, 'PROMPT');
  assert.equal(a.custom_id, 'cmp-3');
  assert.deepEqual(a.params, { model: P.claudeModel, max_tokens: P.maxTokens, temperature: P.temperature, messages: [{ role: 'user', content: 'PROMPT' }] });
  const o = cb.buildOpenAIRequest(0, 'PROMPT', 'gpt-4o');
  assert.deepEqual(o.body, openaiChatBody({ model: 'gpt-4o', messages: [{ role: 'user', content: 'PROMPT' }], maxTokens: P.maxTokens, temperature: P.temperature }));
  const g = cb.buildGeminiRequest(1, 'PROMPT');
  assert.equal(g.request.contents[0].parts[0].text, 'PROMPT');
  assert.equal(g.request.generationConfig.temperature, P.temperature);
  assert.equal(g.request.generationConfig.maxOutputTokens, P.maxTokens);
});

test('sync callers read the shared params (no drift from the batch path)', () => {
  assert.match(core, /COMPARATIVE_PARAMS\.claudeModel/);
  assert.match(core, /COMPARATIVE_PARAMS\.geminiModel/);
  assert.equal((core.match(/COMPARATIVE_PARAMS\.maxTokens/g) || []).length, 3);
  assert.doesNotMatch(core, /model: 'claude-sonnet-4-6'/);
  assert.doesNotMatch(core, /maxOutputTokens: 2000/);
});

test('resultsByPrompt maps by custom id and drops failures', () => {
  const m = cb.resultsByPrompt(['p0', 'p1', 'p2'], [
    { customId: 'cmp-0', success: true, text: 'a' },
    { customId: 'cmp-1', success: false, error: 'x' },
    { customId: 'cmp-2', success: true, text: 'c' },
    { customId: 'bogus', success: true, text: 'z' },
  ]);
  assert.deepEqual([...m.entries()], [['p0', 'a'], ['p2', 'c']]);
});
