/**
 * BRO-4977: a re-extracted body may replace a stored fullText only when it is
 * the same article minus a glued-on tail. Shapes below mirror the real
 * Times Square Chronicles cases checked against the live pages (53 trims).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkBleedTrim, applyBleedTrim, RESCORE_REASON } = require('./page-bleed-repair.js');

const BODY = Array.from({ length: 80 }, (_, i) => `Sentence ${i} of the Soon review about Charlie on her couch.`).join(' ')
  + ' Soon plays at The Loft at St. Luke\'s through November 8.';
const TAIL = ' Slam Frank: Brilliant, Offensive. Suzanna, co-owns and publishes the newspaper Times Square Chronicles. '
  + 'Linda Purl gives a performance that makes it unforgettable. '.repeat(40);

describe('checkBleedTrim', () => {
  test('accepts the body when the stored text is body + tail', () => {
    const v = checkBleedTrim({ fullText: BODY + TAIL }, BODY);
    assert.strictEqual(v.ok, true, v.reason);
  });

  test('accepts when one extractor kept a photo caption and curly quotes', () => {
    const fresh = 'The cast of Soon. Photo by Valerie Terranova ' + BODY.replace(/'/g, '’');
    assert.strictEqual(checkBleedTrim({ fullText: BODY + TAIL }, fresh).ok, true);
  });

  test('accepts when the last short venue line differs', () => {
    const stored = BODY.replace(/ Soon plays at .*$/, '') + TAIL;
    assert.strictEqual(checkBleedTrim({ fullText: stored }, BODY).ok, true);
  });

  test('refuses a different article', () => {
    const other = Array.from({ length: 30 }, (_, i) => `Line ${i} of an unrelated cabaret write-up.`).join(' ');
    assert.strictEqual(checkBleedTrim({ fullText: BODY + TAIL }, other).ok, false);
  });

  test('refuses when there is no tail (stored text already clean)', () => {
    const v = checkBleedTrim({ fullText: BODY }, BODY);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /no tail/);
  });

  test('refuses a body cut off partway through the review', () => {
    const cut = BODY.slice(0, Math.floor(BODY.length * 0.7));
    const markers = ['Suzanna Bowling', 'Suzanna', 'Times Square Chronicles'];
    assert.strictEqual(checkBleedTrim({ fullText: BODY + TAIL }, cut, { tailMarkers: markers }).ok, false);
    assert.strictEqual(checkBleedTrim({ fullText: BODY + TAIL }, BODY, { tailMarkers: markers }).ok, true);
  });

  test('refuses a stub (bot-challenge page, paywall)', () => {
    assert.strictEqual(checkBleedTrim({ fullText: BODY + TAIL }, 'Just a moment...').ok, false);
  });
});

describe('applyBleedTrim', () => {
  test('replaces text, queues a rescore and drops a pull quote from the tail', () => {
    const rec = { fullText: BODY + TAIL, llmPullQuote: 'Linda Purl gives a performance that makes it unforgettable.', assignedScore: 92, rescoreCompletedAt: 'x' };
    const out = applyBleedTrim(rec, BODY, { at: '2026-10-10T00:00:00.000Z', source: 'test' });
    assert.strictEqual(out.fullText, BODY);
    assert.strictEqual(out.needsRescore, true);
    assert.strictEqual(out.rescoreReason, RESCORE_REASON);
    assert.strictEqual(out.llmPullQuote, null);
    assert.strictEqual(out.assignedScore, 92, 'score stays until the rescore replaces it');
    assert.ok(!('rescoreCompletedAt' in out));
    assert.deepStrictEqual(out.pageBleedRepair, { at: '2026-10-10T00:00:00.000Z', previousLength: (BODY + TAIL).length, newLength: BODY.length, source: 'test' });
    assert.strictEqual(rec.fullText, BODY + TAIL, 'input not mutated');
  });

  test('keeps a pull quote that is in the review', () => {
    const rec = { fullText: BODY + TAIL, llmPullQuote: 'Sentence 3 of the Soon review about Charlie on her couch.' };
    assert.strictEqual(applyBleedTrim(rec, BODY).llmPullQuote, rec.llmPullQuote);
  });
});
