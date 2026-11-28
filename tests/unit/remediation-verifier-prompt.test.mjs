import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { buildVerifierPrompt, redactDisputedFields } = require('../../scripts/lib/remediation-verifier.js');

const showCtx = '## Show Data: Awake and Sing! (awake-and-sing-2026)\n```json\n' + JSON.stringify({
  id: 'awake-and-sing-2026', openingDate: '2027-01-07',
  creativeTeam: [{ name: 'Harold Clurman', role: 'Director' }], title: 'Awake and Sing!', venue: 'X' }, null, 2) + '\n```';
const plan = { summary: 's', steps: ['a'], actions: [{ type: 'data-edit', file: 'shows.json', showId: 'awake-and-sing-2026', field: 'creativeTeam', oldValue: 'Harold Clurman', newValue: 'Tyne Rafaeli' }] };
const diag = { summary: 'Director is wrong', whatsHappening: 'Harold Clurman did not direct the revival' };

test('edited (disputed) field is removed from verifier context', () => {
  const p = buildVerifierPrompt(plan, diag, showCtx);
  const ctxPart = p.split('## Show Data From Our Database')[1].split('## Instructions')[0];
  assert.ok(!ctxPart.includes('Harold Clurman'));
  assert.ok(ctxPart.includes('awake-and-sing-2026') && ctxPart.includes('"title"'));
  assert.match(p, /deliberately removed/);
});
test('other shows and non-edited fields are untouched', () => {
  const r = redactDisputedFields(showCtx, { actions: [{ type: 'data-edit', showId: 'other', field: 'creativeTeam' }] });
  assert.deepEqual(r.redacted, []);
  assert.equal(r.context, showCtx);
});
test('id-year vs openingDate is explained; wrong-production fail rule kept', () => {
  const p = buildVerifierPrompt(plan, diag, showCtx);
  assert.match(p, /season the entry was added/);
  assert.match(p, /wrong show or production/);
});
test('generate-remediation-plan uses the shared builder (no inline prompt)', () => {
  const src = fs.readFileSync(new URL('../../scripts/generate-remediation-plan.js', import.meta.url), 'utf8');
  assert.match(src, /buildVerifierPrompt\(plan, diagnosis, showContext\)/);
  assert.ok(!src.includes('You are fact-checking a proposed data fix'));
});
test('verifier call uses the reasoning-capable GPT54_MINI, not gpt-4o-mini (BRO-7608)', () => {
  const src = fs.readFileSync(new URL('../../scripts/generate-remediation-plan.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function verifyPlanWithGPT');
  const call = src.slice(start, src.indexOf('return new Promise', start));
  assert.match(call, /model: GPT54_MINI/);
  assert.match(call, /max_completion_tokens/);
  assert.ok(!/temperature|max_tokens/.test(call.replace(/\/\/.*$/gm, '')));
});
test('redaction only applies to shows.json edits with a concrete showId (review findings)', () => {
  for (const a of [{ type: 'data-edit', showId: null, field: 'creativeTeam' },
                   { type: 'data-edit', file: 'audience-buzz.json', showId: 'awake-and-sing-2026', field: 'title' }]) {
    const r = redactDisputedFields(showCtx, { actions: [a] });
    assert.deepEqual(r.redacted, []);
    assert.equal(r.context, showCtx);
  }
});
test('verifier request pins reasoning_effort none', () => {
  const src = fs.readFileSync(new URL('../../scripts/generate-remediation-plan.js', import.meta.url), 'utf8');
  assert.match(src, /reasoning_effort: 'none'/);
});
