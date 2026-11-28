/**
 * scripts/lib/rebuild-helpers.js normalizeThumb + two-bucket adjudication marker
 * — BRO-4204 audit S6-T6.
 *
 * Uses the REAL normalizeThumb / bothThumbsOpposeVerdict / getBestScore
 * (CLAUDE.md §15).
 *
 * Run: node --test scripts/lib/rebuild-helpers.thumb-adjudication.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { normalizeThumb, bothThumbsOpposeVerdict, getBestScore } = require('./rebuild-helpers.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('normalizeThumb', () => {
  test('canonical spellings pass through', () => {
    assert.equal(normalizeThumb('Up'), 'Up');
    assert.equal(normalizeThumb('Flat'), 'Flat');
    assert.equal(normalizeThumb('Down'), 'Down');
    assert.equal(normalizeThumb('Meh'), 'Flat');
  });

  test('UP / MEH / DOWN (corpus spellings) normalize', () => {
    assert.equal(normalizeThumb('UP'), 'Up');
    assert.equal(normalizeThumb('MEH'), 'Flat');
    assert.equal(normalizeThumb('DOWN'), 'Down');
  });

  test('mixed case and surrounding whitespace normalize', () => {
    assert.equal(normalizeThumb('up'), 'Up');
    assert.equal(normalizeThumb(' Down '), 'Down');
    assert.equal(normalizeThumb('mEh'), 'Flat');
    assert.equal(normalizeThumb('FLAT'), 'Flat');
  });

  test('unknown spellings and null pass through unchanged', () => {
    assert.equal(normalizeThumb('Sideways'), 'Sideways');
    assert.equal(normalizeThumb(null), null);
    assert.equal(normalizeThumb(undefined), undefined);
  });
});

describe('bothThumbsOpposeVerdict — two-bucket disagreement', () => {
  test('both Down vs Positive (71) → true; both Down vs Rave (90) → true', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, 71), true);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, 90), true);
  });

  test('both Up vs Negative (40) / Pan (20) → true', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Up', bwwThumb: 'Up' }, 40), true);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'UP', bwwThumb: 'up' }, 20), true);
  });

  test('one-bucket gaps are not adjudication cases: Mixed verdict, or thumbs Flat', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Up', bwwThumb: 'Up' }, 60), false);   // Mixed
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, 55), false); // Mixed
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Meh', bwwThumb: 'Meh' }, 90), false);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'MEH', bwwThumb: 'Down' }, 90), false);
  });

  test('thumbs must agree with each other, and both must be present', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Up', bwwThumb: 'Down' }, 90), false);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down' }, 90), false);
    assert.equal(bothThumbsOpposeVerdict({ bwwThumb: 'Down' }, 90), false);
    assert.equal(bothThumbsOpposeVerdict({}, 90), false);
  });

  test('agreeing thumbs are not a disagreement', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Up', bwwThumb: 'Up' }, 85), false);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, 30), false);
  });

  test('non-numeric score → false', () => {
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, null), false);
    assert.equal(bothThumbsOpposeVerdict({ dtliThumb: 'Down', bwwThumb: 'Down' }, '80'), false);
  });
});

describe('getBestScore stamps needsAdjudication on a v6 verdict both thumbs oppose', () => {
  // Real corpus case (good-night-and-good-luck-2025/timeout--adam-feldman.json):
  // anchored-v6 71 (Positive) vs DTLI Down + BWW Down.
  const V6_OPPOSED = {
    outletId: 'timeout',
    scoreSource: 'anchored-v6',
    llmScore: { score: 71, confidence: 'high' },
    ensembleData: {},
    fullText: 'x'.repeat(300),
    dtliThumb: 'Down',
    bwwThumb: 'DOWN',
  };

  test('verdict still ships, marked needsAdjudication and queued', () => {
    const flags = [];
    const stats = {};
    const result = getBestScore(V6_OPPOSED, { stats, flagForHumanReview: (d, reason, detail) => flags.push({ reason, detail }) });
    assert.deepEqual(result, { score: 71, source: 'anchored-v6', needsAdjudication: true });
    assert.equal(stats.bothThumbsOpposeV6Verdict, 1);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].reason, 'both-thumbs-disagree-with-llm');
    assert.match(flags[0].detail, /Down\/Down/);
  });

  test('llm-v6 verdict too', () => {
    const result = getBestScore({ ...V6_OPPOSED, scoreSource: 'llm-v6', llmScore: { score: 30, confidence: 'high' }, dtliThumb: 'UP', bwwThumb: 'Up' });
    assert.deepEqual(result, { score: 30, source: 'llm-v6', needsAdjudication: true });
  });

  test('no marker when only one thumb disagrees, or the gap is one bucket', () => {
    assert.deepEqual(getBestScore({ ...V6_OPPOSED, bwwThumb: 'Up' }), { score: 71, source: 'anchored-v6' });
    assert.deepEqual(getBestScore({ ...V6_OPPOSED, llmScore: { score: 60, confidence: 'high' } }), { score: 60, source: 'anchored-v6' });
    assert.deepEqual(getBestScore({ ...V6_OPPOSED, dtliThumb: null, bwwThumb: null }), { score: 71, source: 'anchored-v6' });
  });

  test('rebuild-all-reviews.js emits needsAdjudication from the scoreResult, and the adjudication queue reads the flag reason', () => {
    const rebuild = fs.readFileSync(path.join(HERE, '..', 'rebuild-all-reviews.js'), 'utf8');
    assert.match(rebuild, /scoreResult\.needsAdjudication \? \{ needsAdjudication: true \} : \{\}/);
    // The queue consumes needs-human-review.json rows by `reason`; the marker's
    // flag uses the reason the queue already adjudicates.
    const queue = fs.readFileSync(path.join(HERE, '..', 'adjudicate-review-queue.js'), 'utf8');
    assert.match(queue, /review\.reason/);
  });
});
