/**
 * BRO-7529: Claude-leg shadow A/B. Guards the two things that silently break
 * the comparison: (1) the request params per Claude model (claude-sonnet-5-5
 * 400s on temperature and on disabled thinking; the pinned 4.6 must keep
 * temperature 0.3 so production requests are unchanged), (2) the Claude-leg
 * metrics read claudeScore, not the OpenAI fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { computeReport } = require('../../scripts/lib/openai-leg-ab-metrics.js');

test('claudeSamplingParams: 4.6 keeps temperature 0.3, 5.5 sends no temperature and between_tools thinking', () => {
  const out = execFileSync('npx', ['ts-node', '--transpile-only', '--project', 'scripts/tsconfig.json', '-e',
    "const {claudeSamplingParams:f}=require('./scripts/llm-scoring/scorer');console.log(JSON.stringify([f('claude-sonnet-4-6'),f('claude-sonnet-5-5')]))"],
  { cwd: root, encoding: 'utf8' });
  const [old, nw] = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(old, { temperature: 0.3 });
  assert.deepEqual(nw, { thinking: { type: 'between_tools' } });
  assert.equal('temperature' in nw, false);
});

const arm = (score, bucket, claudeScore, extra = {}) => ({ success: true, rejected: false, score, bucket, claudeScore, claudeLegOk: true, claudeLegRejected: false, openaiScore: 50, ...extra });

test('computeReport leg=claude scores accuracy on claudeScore and counts claude leg errors', () => {
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push({ id: `a${i}`, showId: `s${i % 12}`, weight: 1, band: { floor: 70, ceiling: 90 },
      control: arm(80, 'Positive', 80), shadow: arm(80, 'Positive', i === 0 ? 40 : 80) });
  }
  recs[1].shadow = arm(80, 'Positive', null, { claudeLegOk: false });
  const r = computeReport(recs, { leg: 'claude' });
  assert.equal(r.gates.legAccuracy.value.n, 39);
  assert.ok(r.gates.legAccuracy.value.shadow > r.gates.legAccuracy.value.control);
  assert.equal(r.gates.shadowErrors.value.shadow, +(1 / 40).toFixed(4));
  // default (openai) path unchanged: the openai fields are identical in both arms
  const o = computeReport(recs);
  assert.equal(o.gates.legAccuracy.value.shadow, o.gates.legAccuracy.value.control);
});

test('BRO-7537: batch request for the scoring pin never carries temperature on 5.5 (API 400)', () => {
  const { buildAnthropicBatchRequest } = require('../../scripts/lib/llm-batch.js');
  const { SCORING_SONNET } = require('../../scripts/lib/models.js');
  const mk = (model) => buildAnthropicBatchRequest({ customId: 'x', model, systemPrompt: 's', userPrompt: 'u' }).params;
  const pin = mk(SCORING_SONNET);
  if (SCORING_SONNET.startsWith('claude-sonnet-5')) {
    assert.equal('temperature' in pin, false);
    assert.deepEqual(pin.thinking, { type: 'between_tools' });
  }
  assert.equal(mk('claude-sonnet-4-6').temperature, 0.3);
});
