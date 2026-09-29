/**
 * BRO-4287: aggregator-thumb cross-check (scripts/lib/rebuild-helpers.js
 * aggregatorThumbCheck) and its wiring into getBestScore's v6 and P1 paths.
 * Uses the REAL functions (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/aggregator-thumb-check.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregatorThumbCheck, getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

const check = (dtliThumb, bwwThumb, score, opts) => aggregatorThumbCheck({ dtliThumb, bwwThumb }, score, opts);

describe('aggregatorThumbCheck: expectation and match', () => {
  test('no thumbs, unknown spellings, or a bad score → nothing', () => {
    assert.deepEqual(check(null, null, 80), { expectedThumb: null, thumbsMatch: null, flag: null });
    assert.deepEqual(check('Sideways', null, 80), { expectedThumb: null, thumbsMatch: null, flag: null });
    assert.deepEqual(check('Up', 'Up', null), { expectedThumb: null, thumbsMatch: null, flag: null });
  });

  test('agreeing or single thumb sets the expectation (any casing)', () => {
    assert.deepEqual(check('UP', 'up', 85), { expectedThumb: 'Up', thumbsMatch: true, flag: null });
    assert.deepEqual(check(null, 'Down', 40), { expectedThumb: 'Down', thumbsMatch: true, flag: null });
    assert.deepEqual(check('MEH', null, 62), { expectedThumb: 'Flat', thumbsMatch: true, flag: null });
  });

  test('decisive + Flat pair has no majority → no expectation, no flag', () => {
    assert.deepEqual(check('Up', 'Meh', 40), { expectedThumb: null, thumbsMatch: null, flag: null });
  });

  test('a Flat expectation never flags', () => {
    const r = check('Meh', 'Meh', 95);
    assert.equal(r.thumbsMatch, false);
    assert.equal(r.flag, null);
  });
});

describe('aggregatorThumbCheck: flags', () => {
  test('opposite direction flags; both-agree keeps the existing reason', () => {
    assert.equal(check('Down', 'Down', 75).flag.reason, 'both-thumbs-disagree-with-llm');
    assert.equal(check('Down', null, 75).flag.reason, 'aggregator-thumb-contradicts-llm');
    assert.equal(check(null, 'Up', 40).flag.reason, 'aggregator-thumb-contradicts-llm');
  });

  test('one-step gap flags only past the 5-point margin', () => {
    assert.equal(check('Down', null, 59).flag, null);
    assert.equal(check('Down', null, 60).flag.reason, 'aggregator-thumb-contradicts-llm');
    assert.equal(check('Up', 'Up', 65).flag, null);
    assert.equal(check('Up', 'Up', 64).flag.reason, 'aggregator-thumb-contradicts-llm');
    assert.equal(check('Up', 'Up', 64).thumbsMatch, false);
  });

  test('Up vs Down split flags (School Girls 2026 TheWrap: DTLI Down, BWW Up, 58)', () => {
    const r = check('Down', 'Up', 58);
    assert.equal(r.expectedThumb, null);
    assert.equal(r.flag.reason, 'aggregator-thumbs-split');
    assert.match(r.flag.detail, /Down\/Up/);
  });

  test('anchored (star-banded) verdicts flag only an opposite-direction gap', () => {
    assert.equal(check('Down', 'Up', 58, { anchored: true }).flag, null);
    assert.equal(check('Down', null, 65, { anchored: true }).flag, null);
    assert.equal(check('Down', 'Down', 71, { anchored: true }).flag.reason, 'both-thumbs-disagree-with-llm');
  });
});

describe('getBestScore wiring: score unchanged, queued exactly once', () => {
  const run = (data) => {
    const flags = [];
    const result = getBestScore(data, { stats: {}, flagForHumanReview: (d, reason, detail) => flags.push({ reason, detail }) });
    return { result, flags };
  };

  test('School Girls TheWrap shape (llm-v6, split thumbs) → same score, needsAdjudication, one flag', () => {
    const { result, flags } = run({
      outletId: 'thewrap', scoreSource: 'llm-v6',
      llmScore: { score: 58, confidence: 'medium' }, ensembleData: { needsReview: true },
      fullText: 'x'.repeat(300), dtliThumb: 'Down', bwwThumb: 'Up',
    });
    assert.deepEqual(result, { score: 58, source: 'llm-v6', needsAdjudication: true });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].reason, 'aggregator-thumbs-split');
  });

  test('P1 high-confidence llmScore with a single contradicting thumb → same score, one flag', () => {
    const { result, flags } = run({
      outletId: 'someoutlet', scoreSource: 'llmScore',
      llmScore: { score: 78, confidence: 'high' }, ensembleData: { needsReview: false },
      fullText: 'x'.repeat(300), dtliThumb: 'Down',
    });
    assert.deepEqual(result, { score: 78, source: 'llmScore', needsAdjudication: true });
    assert.equal(flags.length, 1);
  });

  test('agreeing thumbs → no flag, no marker', () => {
    const { result, flags } = run({
      outletId: 'someoutlet', scoreSource: 'llm-v6',
      llmScore: { score: 85, confidence: 'high' }, ensembleData: {},
      fullText: 'x'.repeat(300), dtliThumb: 'Up', bwwThumb: 'Up',
    });
    assert.deepEqual(result, { score: 85, source: 'llm-v6' });
    assert.equal(flags.length, 0);
  });

  test('an adjudicated review is not re-queued', () => {
    const { result, flags } = run({
      outletId: 'someoutlet', scoreSource: 'llm-v6', adjudicatedScore: 45,
      llmScore: { score: 58, confidence: 'high' }, ensembleData: {},
      fullText: 'x'.repeat(300), dtliThumb: 'Down', bwwThumb: 'Up',
    });
    assert.equal(result.score, 45);
    assert.equal(flags.length, 0);
  });
});
