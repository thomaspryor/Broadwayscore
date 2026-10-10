import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCreditQuery, buildCreditPrompt, parseCreditVerdict, groundCredit } = require('./credit-grounding.js');
const { verifyCreativeTeamViaSerp } = require('./creative-team-verify.js');

const glow = { title: 'The Glow', venue: 'Royal Court', openingDate: '2022-01-20' };
const glowRes = [{ title: "The Glow review – Alistair McDowall's time-bending fantasy", snippet: "At the Royal Court, Alistair McDowall's new play follows a woman taken from an asylum in 1863." }];

test('buildCreditQuery names the production and the role', () => {
  assert.equal(buildCreditQuery(glow, 'Playwright'), '"The Glow" Royal Court 2022 playwright');
});

test('buildCreditPrompt carries the claim, the production and the evidence', () => {
  const p = buildCreditPrompt(glow, { name: 'Lucy Kirkwood', role: 'Playwright' }, glowRes);
  assert.match(p, /Lucy Kirkwood as Playwright/);
  assert.match(p, /"The Glow" at Royal Court \(2022\)/);
  assert.match(p, /Alistair McDowall's new play/);
  assert.match(p, /do not rely on your own memory/);
});

test('parseCreditVerdict keeps only an explicit SUPPORTED', () => {
  assert.equal(parseCreditVerdict('SUPPORTED: credited in result 1').supported, true);
  assert.equal(parseCreditVerdict('CONTRADICTED: result 1 credits Alistair McDowall').supported, false);
  assert.equal(parseCreditVerdict('UNSUPPORTED: no credit given').supported, false);
  assert.equal(parseCreditVerdict('I think so').verdict, 'UNPARSEABLE');
  assert.equal(parseCreditVerdict(null).supported, false);
});

test('groundCredit: no snippets or a failing judge drops the credit', async () => {
  assert.equal((await groundCredit(glow, { name: 'X', role: 'Playwright' }, { search: async () => [], judge: async () => 'SUPPORTED: x' })).verdict, 'NO_RESULTS');
  assert.equal((await groundCredit(glow, { name: 'X', role: 'Playwright' }, { search: async () => { throw new Error('down'); }, judge: async () => 'SUPPORTED: x' })).supported, false);
  assert.equal((await groundCredit(glow, { name: 'X', role: 'Playwright' }, { search: async () => glowRes, judge: async () => { throw new Error('429'); } })).supported, false);
});

// The real failure: "The Glow ... written by Lucy Kirkwood" passed the phrase
// check (a season page naming both), though the play is Alistair McDowall's.
test('verifyCreativeTeamViaSerp with ground drops a phrase-confirmed writer the production search contradicts', async () => {
  const serpQuery = async () => [
    { title: 'Royal Court season', snippet: 'The Glow, written by Lucy Kirkwood, joins the season.' },
    { title: 'The Glow', snippet: 'The Glow, written by Alistair McDowall, opens in January.' },
  ];
  const judged = [];
  const judge = async p => { judged.push(p); return /Lucy Kirkwood as/.test(p) ? 'CONTRADICTED: result 1 credits Alistair McDowall' : 'SUPPORTED: result 1'; };
  const out = await verifyCreativeTeamViaSerp(glow, [
    { name: 'Lucy Kirkwood', role: 'Playwright' },
    { name: 'Alistair McDowall', role: 'Playwright' },
  ], '2022', 'serp-verified-llm', { serpQuery, sleep: async () => {}, ground: { search: async () => glowRes, judge } });
  assert.deepEqual(out.map(m => m.name), ['Alistair McDowall']);
  assert.equal(judged.length, 2);
  // Without ground (IBDB callers) the phrase check alone decides, as before.
  const loose = await verifyCreativeTeamViaSerp(glow, [{ name: 'Lucy Kirkwood', role: 'Playwright' }], '2022', 'x', { serpQuery, sleep: async () => {} });
  assert.equal(loose.length, 1);
});
