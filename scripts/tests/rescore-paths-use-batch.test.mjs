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

test('comparative-rescore invocations carry the batch flag decided by rescore-batch-policy.js (BRO-7807)', () => {
  const s = stepBody('Comparative within-band rescore (WE/OWE anchored-v6, capped)');
  const calls = s.split('\n').filter((l) => l.includes('comparative-rescore.ts') && l.includes('npx'));
  assert.ok(calls.length >= 2);
  for (const l of calls) assert.match(l, /\$CMP_BATCH/, l);
  assert.match(s, /scripts\/lib\/rescore-batch-policy\.js\)" == "true"/);
  assert.match(s, /DISABLE_BATCH_SCORING/); // kill switch still reaches the policy
  assert.match(s, /SHOW_ID="\$\{INPUT_SHOW_ID\}"/); // per-show runs stay sync (decided in the policy)
});

const NOW = Date.parse('2026-11-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('missingKeys: answered or in-flight prompts are not re-submitted; stale ones are', () => {
  const [ka, kb, kc] = ['a', 'b', 'c'].map(cb.promptKey);
  const v = {
    inflight: { id: 'b1', keys: [kb], submittedAt: iso(NOW - 3600e3) },
    answers: { [ka]: { text: 'x', at: iso(NOW - 3600e3) } },
  };
  assert.deepEqual(cb.missingKeys(v, [ka, kb, kc], NOW), [kc]);
  const stale = { answers: { [ka]: { text: 'x', at: iso(NOW - 25 * 3600e3) } } };
  assert.deepEqual(cb.missingKeys(stale, [ka], NOW), [ka]);
  assert.equal(cb.usableInflight({ inflight: { id: 'b1', keys: [], submittedAt: iso(NOW - 25 * 3600e3) } }, NOW), null);
});

test('a vendor that finished first keeps its answers while a slower vendor is in flight', () => {
  const k = cb.promptKey('p');
  const reply = '[{"id":"r1","score":70,"warmthRank":1}]';
  const done = cb.recordTerminal({}, [k], new Map([[k, reply]]), NOW);
  const state = { openai: done, gemini: { inflight: { id: 'g', keys: [k], submittedAt: iso(NOW) } } };
  assert.equal(cb.allVendorsRecorded(state, k, NOW), false); // defers the group
  state.gemini = cb.recordTerminal(state.gemini, [k], new Map(), NOW); // ended without an answer
  assert.equal(state.gemini.answers[k].text, '');
  assert.equal(cb.allVendorsRecorded(state, k, NOW), true); // terminal failure no longer blocks (sync parity)
  assert.equal(state.openai.answers[k].text, reply);
});

test('prompt-set change does not orphan: keys are content-based and pruneAnswers keeps wanted + fresh only', () => {
  const [a, b] = ['a', 'b'].map(cb.promptKey);
  const v = { answers: { [a]: { text: 'x', at: iso(NOW) }, [b]: { text: 'y', at: iso(NOW) } } };
  assert.deepEqual(Object.keys(cb.pruneAnswers(v, [a], NOW).answers), [a]);
  assert.equal(cb.promptKey('a'), a);
});

test('comparative-rescore never falls back to a sync call in batch mode', () => {
  const src = fs.readFileSync(new URL('../llm-scoring/comparative-rescore.ts', import.meta.url), 'utf8');
  assert.match(src, /activeModels = batchedModels\(models, batchState\)/);
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

test('resultsByKey maps by custom id and drops failures', () => {
  const m = cb.resultsByKey(['p0', 'p1', 'p2'], [
    { customId: 'cmp-0', success: true, text: 'a' },
    { customId: 'cmp-1', success: false, error: 'x' },
    { customId: 'cmp-2', success: true, text: 'c' },
    { customId: 'bogus', success: true, text: 'z' },
  ]);
  assert.deepEqual([...m.entries()], [['p0', 'a'], ['p2', 'c']]);
});

test('stored batch answers keep scores only: no model reasoning reaches the committed state file', () => {
  const { parseComparativeResponse } = require('../lib/comparative-band.js');
  const raw = '```json\n[{"id":"r1","score":72,"warmthRank":1,"reasoning":"quotes \\"a dazzling revival\\""},{"id":"r2","score":55,"warmthRank":2,"reasoning":"cooler"}]\n```';
  const v = cb.recordTerminal(undefined, ['k1', 'k2'], new Map([['k1', raw], ['k2', 'not json at all']]));
  assert.ok(!v.answers.k1.text.includes('reasoning') && !v.answers.k1.text.includes('dazzling'));
  assert.deepStrictEqual(parseComparativeResponse(v.answers.k1.text, ['r1', 'r2']), {
    r1: { score: 72, warmthRank: 1, reasoning: '' }, r2: { score: 55, warmthRank: 2, reasoning: '' },
  });
  assert.strictEqual(v.answers.k2.text, '', 'unparseable reply is a terminal failure, not stored raw');
});

test('a vendor that keeps failing to submit stops blocking groups after MAX_SUBMIT_FAILURES runs', () => {
  const src = fs.readFileSync(new URL('../llm-scoring/comparative-batch.ts', import.meta.url), 'utf8');
  assert.ok(cb.MAX_SUBMIT_FAILURES >= 1);
  assert.match(src, /fails >= cb\.MAX_SUBMIT_FAILURES\s*\?\s*cb\.recordTerminal\(state\[name\], missing, new Map\(\)\)/);
  const v = cb.recordTerminal({ answers: {}, submitFailures: 2 }, ['k1'], new Map());
  assert.ok(cb.allVendorsRecorded({ a: v }, 'k1'), 'terminal empty answer lets the group settle on the other vendors');
});
