/**
 * BRO-866: explicit star ratings at star-rating outlets must win over LLM scores.
 * Cases from the card: NYSR "Data" (5 unicode stars), Guardian "Cats" (4 stars),
 * Culture Sauce "Cats" (★★★★☆ at the end of the text).
 * Uses the real extractScore/getBestScore so a production regression fails here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore, KNOWN_STAR_OUTLETS } = require('../../scripts/lib/score-extractors.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

const BODY = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40);

describe('BRO-866 explicit star extraction', () => {
  test('NYSR five unicode stars extract to 100', () => {
    const r = extractScore('', `★★★★★ ${BODY}`, 'nysr', 'Data');
    assert.strictEqual(r.normalizedScore, 100);
    assert.strictEqual(r.originalScore, '5/5 stars');
  });

  test('Guardian (known star outlet) extracts anchored stars when no extractor hit', () => {
    assert.ok(KNOWN_STAR_OUTLETS.has('guardian'));
    const r = extractScore('', `★★★★☆ ${BODY}`, 'guardian', 'Cats');
    assert.strictEqual(r.normalizedScore, 80);
  });

  test('Culture Sauce trailing stars extract to 80', () => {
    const r = extractScore('', `${BODY} ★★★★☆`, 'culture-sauce', 'Cats');
    assert.strictEqual(r.normalizedScore, 80);
  });

  test('mid-body stars (pull quotes) are not trusted', () => {
    const mid = `${BODY.slice(0, 1000)} ★★★★★ ${BODY.slice(0, 1000)}`;
    assert.strictEqual(extractScore('', mid, 'guardian', 'Cats'), null);
  });
});

describe('BRO-866 getBestScore does not defer to LLM', () => {
  const base = { showTitle: 'Cats', llmScore: { score: 82, confidence: 'high' } };

  test('explicit originalScore wins over LLM', () => {
    const r = getBestScore({ ...base, outletId: 'culture-sauce', originalScore: '4/5 stars', fullText: BODY });
    assert.ok(r && r.score === 80, JSON.stringify(r));
    assert.notStrictEqual(r.source, 'llmScore');
  });

  test('known star outlet with only fullText stars recovers the star score', () => {
    const r = getBestScore({ ...base, outletId: 'guardian', fullText: `★★★★☆ ${BODY}` });
    assert.ok(r && r.score === 80, JSON.stringify(r));
    assert.strictEqual(r.source, 'originalScore-inline-recovery');
  });
});

// BRO-4838: the fallthrough only matched contiguous runs of 3-5 glyphs, so a
// 1★/2★ verdict or a spaced run ("★ ★ ★ ★ ☆") was never stored and the review
// scored unanchored (Affluenza, Theatre and Tonic "★" scored 42).
describe('BRO-4838 star groups', () => {
  const CHROME = ' The Latest 6 October 2026 Another show at Somewhere Review Read more'.repeat(20);

  test('lone ★ before the sign-off is a 1-star verdict even with trailing chrome', () => {
    const t = `${BODY} Affluenza plays at Riverside Studios until 28th November 2026. ★ Written by Bronagh for Theatre and Tonic, October 2026.${CHROME}`;
    const r = extractScore('', t, 'theatreandtonic', 'Affluenza');
    assert.strictEqual(r.originalScore, '1/5 stars');
    assert.strictEqual(r.normalizedScore, 20);
  });

  test('spaced and wrapped runs count as one rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ★ ★ ★ ★ ☆`, 'guardian', 'X').originalScore, '4/5 stars');
    assert.strictEqual(extractScore('', `${BODY} ★★ ★★★ Written by Bronagh`, 'theatreandtonic', 'X').originalScore, '5/5 stars');
  });

  test('2-star opening line is read', () => {
    const r = extractScore('', `Teeth 'N' Smiles review and star rating: ★★ ${BODY}`, 'city-am', "Teeth 'N' Smiles");
    assert.strictEqual(r.originalScore, '2/5 stars');
  });

  test('roundup picks the short run named for this show, not its neighbour', () => {
    const t = `${BODY} Star ratings (out of five) Infinite Life ★★★★★ The Homecoming ★★ Pacific Overtures ★★★ Infinite Life is at the Dorfman.`;
    assert.strictEqual(extractScore('', t, 'guardian', 'The Homecoming').originalScore, '2/5 stars');
    assert.strictEqual(extractScore('', t, 'guardian', 'Pacific Overtures').originalScore, '3/5 stars');
  });

  test('a lone ★ among other unnamed star groups is decoration, not a rating', () => {
    const t = `${BODY} Theatre Royal ★ Save up to 56% Lyceum Theatre ★ No booking fee`;
    assert.strictEqual(extractScore('', t, 'guardian', 'Cats'), null);
  });

  // Second-opinion findings on the first cut of this change.
  test('a lone ☆ is not a 0-star rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ☆ Save to favourites`, 'guardian', 'Cats'), null);
  });

  test('a half before the empty stars keeps the half', () => {
    assert.strictEqual(extractScore('', `${BODY} ★★★½☆`, 'guardian', 'Cats').originalScore, '3.5/5 stars');
  });

  test('a rating and a decoration on the next line do not merge', () => {
    const r = extractScore('', `${BODY} Verdict ★★★★\n\n★ Recommended`, 'guardian', 'Cats');
    assert.notStrictEqual(r && r.originalScore, '5/5 stars');
  });

  test('a sole ★ badge with no rating context is not a 1-star verdict', () => {
    assert.strictEqual(extractScore('', `${BODY} ★ Top pick this week`, 'guardian', 'Cats'), null);
  });

  test('more than five glyphs is not a 5-star rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ★★★★★★★`, 'guardian', 'Cats'), null);
  });
});
