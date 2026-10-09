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
test('parses an explicit MATCH (verdict alone on first line)', async () => {
  const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => 'MATCH\nConsistent with the cast and year.');
  assert.equal(r.match, true);
});

test('accepts MATCH with trailing period', async () => {
  assert.equal((await verifyProductionMatch(SHOW, 'x', async () => 'MATCH.')).match, true);
});

test('parses an explicit MISMATCH', async () => {
  const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => 'MISMATCH\nThis is the 2024 play "All of Me".');
  assert.equal(r.match, false);
});

// Codex ship-check 2026-06-21: a hedged/contradictory verdict must FAIL CLOSED,
// not parse as MATCH off the leading token.
test('reject hedged same-line MATCH ("MATCH - but venue does not line up")', async () => {
  for (const out of [
    'MATCH - but the venue and cast do not line up',
    'MATCH, though I am not fully certain',
    'MATCH\nActually on reflection this is a MISMATCH',
    'Verdict: MATCH',
    'match, actually no',
  ]) {
    const r = await verifyProductionMatch(SHOW, 'a synopsis', async () => out);
    assert.equal(r.match, false, `expected mismatch for verdict ${JSON.stringify(out)}`);
  }
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

test('prompt includes the identifying production facts + sparse-record rule', () => {
  const p = buildVerificationPrompt(SHOW, 'some plot');
  assert.match(p, /All About Me/);
  assert.match(p, /2010/);
  assert.match(p, /Stephen Sondheim Theatre/);
  assert.match(p, /Dame Edna Everage/);
  assert.match(p, /MATCH or MISMATCH/);
  assert.match(p, /too sparse/i); // sparse record → MISMATCH instruction present
});

// BRO-4851: half the West End historical rows have only previewsStartDate; the
// verifier saw "Year: ?" and is told to answer MISMATCH on sparse records.
test('verification prompt uses the first-preview year when openingDate is missing', () => {
  const prompt = buildVerificationPrompt({ title: 'Kyoto', venue: 'Soho Place', previewsStartDate: '2025-01-09' }, 'A play about the 1997 climate talks.');
  assert.match(prompt, /2025/);
  assert.doesNotMatch(prompt, /Year: \?/);
});

// BRO-4884: Opus rejected generic plots of King Lear, Pygmalion, Private Lives
// for WE revivals "for lacking production-specific details" (run 37868803406).
test('prompt lets a revival match on its source work\'s story', () => {
  const p = buildVerificationPrompt({ title: 'King Lear', openingDate: '2023-11-01', type: 'play', venue: "Wyndham's Theatre" }, 'plot');
  assert.match(p, /revival or new staging of a well-known work/);
  assert.match(p, /Do not answer MISMATCH only because production-specific details are missing/);
  assert.match(p, /different show that merely shares the title/);
});
