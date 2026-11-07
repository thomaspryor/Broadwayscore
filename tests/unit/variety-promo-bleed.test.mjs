import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findVarietyPromoBleed, hasVarietyPromoBleed, stripVarietyPromoBleed, applyVarietyPromoStrip, isProseLine, isExcludedRow, RESCORE_REASON,
  duplicatedLead,
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
  assert.deepEqual(out.varietyPromoStrip, { ...first, newLength: 2 }, 'baseline score kept, length follows the text');
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

const { hasDuplicatedLead, dropDuplicatedLead, restoreBigMove, undoRestore } = require('../../scripts/lib/variety-promo-bleed.js');

test('drops an exactly repeated lead paragraph and nothing else', () => {
  const lead = para('lead', 2);
  const body = `${para('second')}\n\n${para('third')}`;
  assert.equal(dropDuplicatedLead(`${lead}\n\n${lead}\n\n${body}`), `${lead}\n\n${body}`);
  // whitespace differences still count as the same paragraph
  assert.equal(hasDuplicatedLead(`${lead}\n\n${lead.replace(/ /g, '  ')}\n\n${body}`), true);
  // a lead that starts the next paragraph is a near repeat (the older excerpt)
  assert.equal(duplicatedLead(`${lead}\n\n${lead} More words.\n\n${body}`).kind, 'near');
  // a short lead (a dek or a kicker) is left alone
  assert.equal(hasDuplicatedLead(`Short.\n\nShort.\n\n${body}`), false);
  // no third paragraph: the repeat would be the whole remaining text
  assert.equal(hasDuplicatedLead(`${lead}\n\n${lead}`), false);
  assert.equal(dropDuplicatedLead(body), body);
});

test('the strip also drops a duplicated lead, with or without a promo block', () => {
  const lead = 'Opening night brought a starry crowd and a long ovation for a revival that had been years in the making.';
  const promo = `${lead}\n\n${lead}\n\n${para('second')}\n\nRelated Stories\n\nSome Other Show Gets a Revival Date\n\n${para('third')}\n\n${para('fourth')}`;
  const r = stripVarietyPromoBleed(promo);
  assert.equal(r.refused, null);
  assert.equal(hasDuplicatedLead(r.text), false);
  assert.equal(hasVarietyPromoBleed(r.text), false);
  assert.ok(r.text.startsWith(`${lead}\n\n${para('second')}`));
  const plain = `${lead}\n\n${lead}\n\n${para('second')}\n\n${para('third')}`;
  assert.equal(stripVarietyPromoBleed(plain).text, `${lead}\n\n${para('second')}\n\n${para('third')}`);
});

test('restoreBigMove keeps the pre-strip score on a 5+ move or a bucket change only', () => {
  const text = para('kept', 30);
  const base = (score, bucket, extra = {}) => ({
    fullText: text, assignedScore: score, needsRescore: false,
    llmScore: { score, bucket, confidence: 'high' },
    llmMetadata: { scoredAt: '2026-10-13T23:35:00Z' },
    varietyPromoStrip: { previousScore: 62, previousBucket: 'Mixed', previousScoredAt: '2025-01-01T00:00:00Z', newLength: text.length },
    ...extra,
  });
  const big = restoreBigMove(base(71, 'Positive'), { at: 'T' });
  assert.equal(big.llmScore.score, 62);
  assert.equal(big.llmScore.bucket, 'Mixed');
  assert.equal(big.llmScore.confidence, 'high');
  assert.equal(big.assignedScore, 62);
  assert.deepEqual(big.varietyPromoStrip.restored, { at: 'T', scoredAt: '2026-10-13T23:35:00Z', rescoredScore: 71, rescoredBucket: 'Positive' });
  assert.equal(restoreBigMove(big), null, 'idempotent for the same rescore');
  assert.equal(restoreBigMove(base(66, 'Mixed')), null, 'a 4-point move in the same bucket stays');
  assert.ok(restoreBigMove(base(64, 'Positive')), 'a bucket change restores even when small');
  assert.equal(restoreBigMove(base(71, 'Positive', { needsRescore: true })), null, 'not rescored yet');
  assert.equal(restoreBigMove(base(71, 'Positive', { llmMetadata: { scoredAt: '2025-01-01T00:00:00Z' } })), null, 'same scoring as the baseline');
  assert.equal(restoreBigMove({ ...base(71, 'Positive'), varietyPromoStrip: { previousScore: null } }), null, 'no baseline');
  assert.equal(restoreBigMove(base(71, 'Positive', { fullText: text + ' refetched' })), null, 'text changed since the strip');
  const noBucket = base(71, 'Positive');
  noBucket.varietyPromoStrip = { ...noBucket.varietyPromoStrip, previousBucket: null };
  assert.equal(restoreBigMove(noBucket), null, 'baseline without a bucket may not be an LLM score');
});

test('undoRestore puts the rescore back once, and restoreBigMove then leaves the row alone', () => {
  const text = para('kept', 30);
  const rescored = {
    fullText: text, assignedScore: 68, needsRescore: false,
    llmScore: { score: 68, bucket: 'Mixed', confidence: 'high' },
    llmMetadata: { scoredAt: '2026-10-13T23:35:00Z' },
    varietyPromoStrip: { previousScore: 86, previousBucket: 'Rave', previousScoredAt: '2025-01-01T00:00:00Z', newLength: text.length },
  };
  const restored = restoreBigMove(rescored, { at: 'T' });
  assert.equal(restored.llmScore.score, 86);
  const undone = undoRestore(restored, { at: 'U' });
  assert.equal(undone.llmScore.score, 68);
  assert.equal(undone.llmScore.bucket, 'Mixed');
  assert.equal(undone.llmScore.confidence, 'high');
  assert.equal(undone.assignedScore, 68);
  assert.equal(undone.varietyPromoStrip.restored.undone, 'U');
  assert.equal(restoreBigMove(undone), null, 'a later --restore-big-moves keeps the reader\'s choice');
  assert.equal(undoRestore(undone), null, 'already undone');
  assert.equal(undoRestore(rescored), null, 'never restored');
  assert.equal(undoRestore({ ...restored, llmMetadata: { scoredAt: '2026-11-01T00:00:00Z' } }), null, 'rescored again since');
  assert.equal(undoRestore({ ...restored, needsRescore: true }), null, 'text changed, waiting for a rescore');
  assert.equal(undoRestore({ ...restored, fullText: restored.fullText + ' refetched' }), null, 'text no longer the stripped text');
});

test('a second strip keeps the first baseline score but tracks the new text length', () => {
  const first = applyVarietyPromoStrip({ fullText: para('x', 40), assignedScore: 70, llmScore: { bucket: 'Positive' } }, para('x', 30), { at: 'A' });
  const second = applyVarietyPromoStrip({ ...first, assignedScore: 55 }, para('x', 20), { at: 'B' });
  assert.equal(second.varietyPromoStrip.previousScore, 70);
  assert.equal(second.varietyPromoStrip.newLength, para('x', 20).length);
});

// Synthetic text in the shape of the ragtime-1998 row: paragraph 1 is Variety's older
// excerpt of the opening, lightly edited, ahead of the full opening.
const OPENING = 'The new musical drawn from the brilliant 1975 novel arrives on Broadway as a sweeping, '
  + 'handsome pageant of three families at the turn of the century, and it is often moving. '
  + 'Its second act is less sure of itself.';
const EXCERPT = 'The new musical drawn from the novel lands on Broadway as a sweeping, handsome pageant '
  + 'of three families at the turn of the century, and it is often moving.';

test('drops a lightly edited excerpt of the opening ahead of the full opening (ragtime shape)', () => {
  const body = `${OPENING}\n\n${para('third')}\n\n${para('fourth')}`;
  const dl = duplicatedLead(`${EXCERPT}\n\n${body}`);
  assert.equal(dl.kind, 'near');
  assert.ok(dl.share >= 0.85 && dl.share < 1);
  assert.equal(dropDuplicatedLead(`${EXCERPT}\n\n${body}`), body);
  // a near repeat that is longer than the paragraph it repeats is left alone
  assert.equal(hasDuplicatedLead(`${OPENING} And more.\n\n${EXCERPT}\n\n${body}`), false);
});

test('keeps a real two-paragraph opening that shares words but is not a repeat', () => {
  const p1 = 'Few musicals have aged as gracefully as this one, which returns to Broadway in a lavish '
    + 'new staging at a big house this season.';
  const p2 = 'The production opens on a bare stage and builds slowly toward a first-act finale that lands '
    + 'with real force, though the musical itself shows its age in places this season on Broadway.';
  const text = `${p1}\n\n${p2}\n\n${para('third')}`;
  assert.equal(duplicatedLead(text), null);
  assert.equal(dropDuplicatedLead(text), text);
  assert.equal(stripVarietyPromoBleed(text).text, text);
});

test('a strip that only drops a repeated lead does not queue a rescore', () => {
  const rec = { fullText: `${EXCERPT}\n\n${OPENING}\n\n${para('third')}`, assignedScore: 70, llmScore: { score: 70, bucket: 'Positive' } };
  const r = stripVarietyPromoBleed(rec.fullText);
  assert.equal(r.blocks.length, 0);
  const out = applyVarietyPromoStrip(rec, r.text, { at: 't', rescore: r.blocks.length > 0 });
  assert.equal(out.needsRescore, undefined);
  assert.equal(out.rescoreReason, undefined);
  assert.equal(out.fullText, r.text);
  // no score baseline: a later unrelated rescore must not be read as the strip's
  assert.deepEqual(out.varietyPromoStrip, { at: 't', previousLength: rec.fullText.length, newLength: r.text.length, leadOnly: true });
  const rescored = { ...out, llmScore: { score: 50, bucket: 'Mixed' }, llmMetadata: { scoredAt: 'later' } };
  assert.equal(restoreBigMove(rescored, { at: 'u' }), null);
  // a promo strip after a lead-only one takes the baseline then
  const later = applyVarietyPromoStrip({ ...out, assignedScore: 70, llmScore: { score: 70, bucket: 'Positive' } }, 'x', { at: 'v' });
  assert.equal(later.needsRescore, true);
  assert.equal(later.varietyPromoStrip.previousScore, 70);
  assert.equal(later.varietyPromoStrip.leadOnly, undefined);
  assert.equal(applyVarietyPromoStrip(rec, r.text, { at: 't' }).needsRescore, true);
});

test('function words alone never make a near repeat', () => {
  const p1 = 'It is the kind of show that is in the end about the way that we are with each other when it is over.';
  const p2 = 'It is, in the end, a show about grief: the way a family that is falling apart is held together '
    + 'by a song that we have all heard before, and the way it lingers when it is over and done.';
  assert.equal(duplicatedLead(`${p1}\n\n${p2}\n\n${para('third')}`), null);
});

test('a lead repeated with straight quotes where paragraph 2 has curly ones is an exact repeat', () => {
  const curly = 'The \u201cFollies\u201d revival is done right, and the director\u2019s cast makes the long evening fly by with real verve.';
  const straight = curly.replace(/[\u201c\u201d]/g, '"').replace(/\u2019/g, "'");
  const t = `${straight}\n\n${curly}\n\n${para('third', 12)}`;
  const d = duplicatedLead(t);
  assert.equal(d && d.kind, 'exact');
  assert.equal(dropDuplicatedLead(t).startsWith(curly), true);
});
