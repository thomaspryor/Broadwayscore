import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './synopsis-production-match.js';
const { verifyProductionMatch, buildVerificationPrompt } = pkg;

const SHOW = {
  title: 'All About Me', openingDate: '2010-03-18', type: 'musical',
  venue: 'Stephen Sondheim Theatre',
  cast: [{ name: 'Dame Edna Everage' }, { name: 'Michael Feinstein' }],
};

// Logic/parsing tests with a mock LLM (deterministic, no API — runs in CI).
test('parses an explicit MATCH', async () => {
  const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => 'MATCH — consistent with the cast and year.');
  assert.equal(r.match, true);
});

test('parses an explicit MISMATCH', async () => {
  const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => 'MISMATCH — this is the 2024 play "All of Me".');
  assert.equal(r.match, false);
});

test('reject-on-doubt: unparseable verdict → mismatch', async () => {
  for (const out of ['', 'maybe?', 'I think this could be the same show', 'YES probably']) {
    const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => out);
    assert.equal(r.match, false, `expected mismatch for verdict ${JSON.stringify(out)}`);
  }
});

test('reject-on-doubt: verifier throwing → mismatch (fail-safe)', async () => {
  const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => { throw new Error('api down'); });
  assert.equal(r.match, false);
  assert.match(r.reason, /verifier error/);
});

test('empty synopsis or missing verifier → mismatch', async () => {
  assert.equal((await verifyProductionMatch(SHOW, '', async () => 'MATCH')).match, false);
  assert.equal((await verifyProductionMatch(SHOW, 'x', null)).match, false);
});

test('prompt includes the identifying production facts', () => {
  const p = buildVerificationPrompt(SHOW, 'some plot');
  assert.match(p, /All About Me/);
  assert.match(p, /2010/);
  assert.match(p, /Stephen Sondheim Theatre/);
  assert.match(p, /Dame Edna Everage/);
  assert.match(p, /MATCH or MISMATCH/);
});
