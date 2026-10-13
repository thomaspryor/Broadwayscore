import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findVarietyPromoBleed, hasVarietyPromoBleed, stripVarietyPromoBleed, applyVarietyPromoStrip, isProseLine, isExcludedRow, RESCORE_REASON,
} = require('../../scripts/lib/variety-promo-bleed.js');

const para = (tag, n = 8) => Array.from({ length: n }, (_, i) => `The ${tag} production keeps its nerve in scene ${i}, and the cast plays it straight.`).join(' ');

test('strips a Related Stories block with its headline and caption lines', () => {
  const text = [para('first'), 'Related Stories ', ' ', 'Penderkar teaser', 'Netflix Orders New Drama From Famous Showrunner (EXCLUSIVE)', ' ', para('second'), para('third')].join('\n');
  const r = stripVarietyPromoBleed(text);
  assert.equal(r.refused, null);
  assert.equal(r.blocks.length, 1);
  assert.deepEqual(r.blocks[0].lines, ['Penderkar teaser', 'Netflix Orders New Drama From Famous Showrunner (EXCLUSIVE)']);
  assert.equal(r.text, `${para('first')}\n\n${para('second')}\n${para('third')}`);
  assert.equal(hasVarietyPromoBleed(r.text), false);
});

test('Popular on Variety followed directly by prose removes only the marker', () => {
  const text = [para('first'), para('second'), 'Popular on Variety', para('third')].join('\n');
  const r = stripVarietyPromoBleed(text);
  assert.equal(r.refused, null);
  assert.deepEqual(r.blocks[0].lines, []);
  assert.ok(r.text.includes(para('third')) && !/Popular on Variety/.test(r.text));
});

test('keeps review prose that mentions the words inline', () => {
  const text = `${para('first')}\nShe reads out the related stories of three women. ${para('x', 2)}\n${para('second')}`;
  assert.deepEqual(findVarietyPromoBleed(text), []);
  assert.equal(hasVarietyPromoBleed(text), false);
  assert.equal(stripVarietyPromoBleed(text).refused, null);
});

test('refuses flat page chrome, a fragment, and a block with no prose after it', () => {
  assert.equal(stripVarietyPromoBleed(`Plus Icon Related Stories ${para('a', 20)}`).refused, 'flat page chrome');
  assert.match(stripVarietyPromoBleed(`Short lede.\nRelated Stories\n\n${para('a', 2)}`).refused, /too short after strip/);
  assert.equal(stripVarietyPromoBleed(`${para('a', 20)}\nRelated Stories\nSome Headline Here Today`).refused, 'block is not a short headline run');
});

test('isProseLine: sentences are prose, Title Case headlines and captions are not', () => {
  assert.equal(isProseLine('The show works. It really does.'), true);
  assert.equal(isProseLine('Broadway Grosses Climb As Summer Season Begins'), false);
  assert.equal(isProseLine('Penderkar teaser'), false);
  assert.equal(isProseLine(''), false);
});

test('applyVarietyPromoStrip queues a rescore and keeps the pre-strip score', () => {
  const rec = { fullText: 'old text with promo', assignedScore: 81, llmScore: { bucket: 'Positive' }, llmMetadata: { scoredAt: 't0' }, llmPullQuote: 'gone line', rescoreCompletedAt: 'x', wordCount: 4 };
  const out = applyVarietyPromoStrip(rec, 'new clean text', { at: '2026-10-13T00:00:00Z' });
  assert.equal(out.fullText, 'new clean text');
  assert.equal(out.wordCount, 3);
  assert.equal(out.needsRescore, true);
  assert.equal(out.rescoreReason, RESCORE_REASON);
  assert.equal(out.llmPullQuote, null);
  assert.equal('rescoreCompletedAt' in out, false);
  assert.deepEqual(out.fullTextTrimmed, { reason: RESCORE_REASON, fromLength: 19, toLength: 14, at: '2026-10-13T00:00:00Z' });
  assert.deepEqual(out.varietyPromoStrip, { at: '2026-10-13T00:00:00Z', previousLength: 19, newLength: 14, previousScore: 81, previousBucket: 'Positive', previousScoredAt: 't0' });
  assert.equal(rec.fullText, 'old text with promo');
});

test('never removes a real sentence that follows a marker (ship-check P1)', () => {
  for (const line of [
    'Directed by Michael Arden, with choreography by Sergio Trujillo.',
    'Consider the opening number:',
    'Running time: TWO HOURS, 30 MIN.',
  ]) {
    const text = [para('first'), 'Related Stories', line, para('second')].join('\n');
    const r = stripVarietyPromoBleed(text);
    // Kept in the text, or the row is refused (refetch); never silently removed.
    assert.ok(r.refused || r.text.includes(line), `kept or refused: ${line}`);
  }
  // A short Title Case sentence could be a headline or a cast line: refuse, refetch.
  const cast = [para('first'), 'Related Stories', 'Sutton Foster and Hugh Jackman Lead the Cast.', para('second')].join('\n');
  assert.equal(stripVarietyPromoBleed(cast).refused, 'block is not a short headline run');
});

test('a marker inline with text is detected and refused, not missed', () => {
  const text = `${para('first')}\nPopular on Variety The production runs long. ${para('x', 2)}\n${para('second')}`;
  assert.equal(hasVarietyPromoBleed(text), true);
  assert.equal(stripVarietyPromoBleed(text).refused, 'marker inline with text');
});

test('a second strip keeps the first pre-strip baseline', () => {
  const first = { at: 't1', previousLength: 9, newLength: 5, previousScore: 70, previousBucket: 'Positive', previousScoredAt: 't0' };
  const out = applyVarietyPromoStrip({ fullText: 'abc', assignedScore: 50, varietyPromoStrip: first }, 'ab', { at: 't2' });
  assert.deepEqual(out.varietyPromoStrip, first);
});

test('isExcludedRow skips every flag the scorer skips (no live score, nothing to strip or A/B)', () => {
  // Same flags scripts/llm-scoring/index.ts logs as dataQualitySkipped; wrongAttribution was missed once (BRO-5254 sample).
  for (const f of ['wrongShow', 'wrongProduction', 'wrongAttribution', 'isNonReview', 'isRoundupArticle', 'fabricatedEntry']) {
    assert.equal(isExcludedRow({ [f]: true }), true, f);
  }
  assert.equal(isExcludedRow({ duplicateOf: 'x/y.json' }), true);
  assert.equal(isExcludedRow({ rejectionReason: 'paywall' }), true);
  assert.equal(isExcludedRow({ contentTier: 'invalid' }), true);
  assert.equal(isExcludedRow({ contentTier: 'complete' }), false);
  assert.equal(isExcludedRow({ wrongAttribution: false }), false);
  assert.equal(isExcludedRow(null), false);
});
