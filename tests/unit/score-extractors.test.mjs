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
