/** synopsis-grounding (BRO-4884). Colocated so CI's scripts/lib/*.test.mjs glob runs it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildGroundingQuery, buildGroundingPrompt, parseGroundingVerdict, groundSynopsis } = require('./synopsis-grounding.js');

const show = { title: 'Instructions for a Teenage Armageddon', venue: 'Garrick Theatre', openingDate: '2024-03-14' };

test('query names the production: quoted title, venue, year', () => {
  assert.equal(buildGroundingQuery(show), '"Instructions for a Teenage Armageddon" Garrick Theatre 2024 review');
});

test('prompt carries the synopsis and the snippets and forbids own knowledge', () => {
  const p = buildGroundingPrompt(show, 'A girl and her emo phase.', [{ title: 'Review', snippet: 'Eileen grieves her sister.' }]);
  assert.match(p, /The search results below are the evidence/);
  assert.match(p, /new original play with no plot in the results is UNSUPPORTED/);
  assert.match(p, /A girl and her emo phase\./);
  assert.match(p, /Eileen grieves her sister\./);
});

test('only an explicit SUPPORTED keeps the synopsis', () => {
  assert.equal(parseGroundingVerdict('SUPPORTED: same premise').supported, true);
  assert.equal(parseGroundingVerdict('**SUPPORTED** - ok').supported, true);
  for (const r of ['CONTRADICTED: sister, not father', 'UNSUPPORTED: no plot in results', 'I think so', '', null]) {
    assert.equal(parseGroundingVerdict(r).supported, false, String(r));
  }
  assert.equal(parseGroundingVerdict('CONTRADICTED: x').verdict, 'CONTRADICTED');
});

test('no search results, a failing search or a failing judge all drop the synopsis', async () => {
  const judge = async () => 'SUPPORTED: fine';
  assert.equal((await groundSynopsis(show, 's', { search: async () => null, judge })).verdict, 'NO_RESULTS');
  assert.equal((await groundSynopsis(show, 's', { search: async () => [{ title: 't' }], judge })).verdict, 'NO_RESULTS');
  assert.equal((await groundSynopsis(show, 's', { search: async () => { throw new Error('quota'); }, judge })).supported, false);
  const r = await groundSynopsis(show, 's', { search: async () => [{ title: 't', snippet: 'x' }], judge: async () => { throw new Error('500'); } });
  assert.equal(r.supported, false);
});

test('a supported verdict over real snippets keeps it', async () => {
  const r = await groundSynopsis(show, 's', { search: async () => [{ title: 't', snippet: 'x' }], judge: async () => 'SUPPORTED: same story' });
  assert.deepEqual([r.supported, r.verdict], [true, 'SUPPORTED']);
});
