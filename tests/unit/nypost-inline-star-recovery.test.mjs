/**
 * Unit tests for NY Post inline-star recovery + anchor guard + LLM-conflict override.
 *
 * Background: 2026-04-22 added 'nypost' (and 16 other US outlets) to
 * KNOWN_STAR_OUTLETS in scripts/lib/score-extractors.js. The P0.75 inline-recovery
 * path in rebuild-helpers.js now fires for NY Post fullText. Pre-mortem flagged
 * a P0 landmine: unicode stars in pull-quotes or ad copy could be false-positive
 * extracted. Fix: anchor matches to first/last 15% of text.
 *
 * A second landmine: inline-recovery bypassed the LLM-override conflict guard.
 * Fix: mirror P0.5's guard in P0.75 — when llm bucket != recovered bucket AND
 * delta > 25 AND llm conf = 'high', override inline recovery.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const { KNOWN_STAR_OUTLETS, extractScore } = require('../../scripts/lib/score-extractors.js');

const BYLINE_OPENER = 'By Johnny Oleksinski\n\nPublished: April 20, 2026\n\n★★★☆☆\n\n';
const LONG_MIDDLE = 'The curtain rises on a set that evokes a quiet riot of cream and velvet, and for the next forty lines of prose we are asked to consider what it means to age into one\'s own body. The writing has moments of real grace — a line about winter, a monologue about a radio — and the direction finds rhythm where the script stumbles. There is a sequence late in act two where the lead, perhaps sensing that the audience is restless, simply stops and breathes, and in that silence the whole play comes briefly alive. The supporting cast is uneven. Two of the three ensemble performers land their beats; the third, for reasons that are not the performer\'s fault, seems stranded between eras. Designers Julia Tang and Marcus Reyes have given the production a handsome frame, even if the sound design occasionally intrudes on the stillness the piece wants. '.repeat(4);
const VERDICT_CLOSER = '\n\nVERDICT: A flawed but memorable evening.\n';

describe('NY Post is registered as a KNOWN_STAR_OUTLET after 2026-04-22', () => {
  test('nypost in KNOWN_STAR_OUTLETS', () => {
    assert.ok(KNOWN_STAR_OUTLETS.has('nypost'));
  });

  test('17 US outlets ported from adjudication-prompt', () => {
    for (const id of ['observer', 'usatoday', 'nypost', 'nydailynews',
                      'chicagotribune', 'chicago-sun-times', 'washpost',
                      'san-francisco-chronicle', 'boston-globe', 'latimes',
                      'newsday', 'amny', 'theatrely', 'curtainup',
                      'ew', 'time', 'rollingstone']) {
      assert.ok(KNOWN_STAR_OUTLETS.has(id), `${id} missing from KNOWN_STAR_OUTLETS`);
    }
  });
});

describe('extractScore anchor guard for KNOWN_STAR_OUTLETS fullText fallthrough', () => {
  test('stars in first 15% of text DO extract (opener byline)', () => {
    const text = BYLINE_OPENER + LONG_MIDDLE;
    const result = extractScore('', text, 'nypost');
    assert.ok(result, 'should extract stars at opener');
    assert.strictEqual(result.source, 'unicode-stars-fallthrough');
    assert.strictEqual(result.normalizedScore, 60); // 3/5 = 60
  });

  test('stars in last 15% of text DO extract (closing verdict)', () => {
    const text = LONG_MIDDLE + '\n\n★★★★☆\n' + VERDICT_CLOSER;
    const result = extractScore('', text, 'nypost');
    assert.ok(result, 'should extract stars at closer');
    assert.strictEqual(result.source, 'unicode-stars-fallthrough');
    assert.strictEqual(result.normalizedScore, 80); // 4/5 = 80
  });

  test('ONLY mid-text pull-quote stars do NOT extract (P0 landmine closed)', () => {
    const midQuote = LONG_MIDDLE.slice(0, 2000) +
      '\n\n"★★★★★ — Time Out" raved the Time Out critic.\n\n' +
      LONG_MIDDLE.slice(2000);
    const result = extractScore('', midQuote, 'nypost');
    assert.strictEqual(result, null,
      'mid-text pull-quote stars must NOT extract as NY Post rating');
  });

  test('ONLY promotional ad stars in middle do NOT extract', () => {
    const adMiddle = LONG_MIDDLE.slice(0, 1500) +
      '\n\n★★★★★ BEST NEW MUSICAL — HAMILTON NOW PLAYING!\n\n' +
      LONG_MIDDLE.slice(1500);
    const result = extractScore('', adMiddle, 'nypost');
    assert.strictEqual(result, null,
      'mid-text promotional ad stars must NOT extract');
  });

  test('Anchor applies to outlets WITHOUT an OUTLET_EXTRACTORS entry (regression: 10 outlets)', () => {
    // latimes, amny, chicagotribune, etc. have no entry in OUTLET_EXTRACTORS but are
    // in KNOWN_STAR_OUTLETS. Prior to fix, they routed through extractGenericStarRating
    // which had no anchor — mid-text pull-quote stars would false-positive.
    const midQuote = LONG_MIDDLE.slice(0, 2000) +
      '\n\n"★★★★★ — Variety" raved the Variety critic.\n\n' +
      LONG_MIDDLE.slice(2000);
    for (const outlet of ['latimes', 'amny', 'chicagotribune', 'boston-globe', 'newsday']) {
      const result = extractScore('', midQuote, outlet);
      assert.strictEqual(result, null,
        `${outlet} mid-text pull-quote stars must NOT extract (anchor fix)`);
    }
  });

  test('Byline stars DO extract for outlets without extractor entry', () => {
    const text = BYLINE_OPENER + LONG_MIDDLE;
    for (const outlet of ['latimes', 'amny', 'chicagotribune']) {
      const result = extractScore('', text, outlet);
      assert.ok(result, `${outlet} should extract opener stars`);
      assert.strictEqual(result.source, 'unicode-stars-fallthrough');
      assert.strictEqual(result.normalizedScore, 60);
    }
  });
});

describe('getBestScore P0.75 inline recovery for NY Post', () => {
  test('NY Post file with anchored stars in fullText returns inline-recovery score', () => {
    const data = {
      outletId: 'nypost',
      outlet: 'New York Post',
      fullText: BYLINE_OPENER + LONG_MIDDLE,
      _showCategory: 'broadway',
    };
    const stats = {};
    const result = getBestScore(data, { stats });
    assert.ok(result, 'should return a score');
    assert.strictEqual(result.source, 'originalScore-inline-recovery');
    assert.strictEqual(result.score, 60); // 3/5 stars = 60
    assert.strictEqual(stats.inlineStarRecovery, 1);
  });

  test('NY Post file with ONLY mid-text pull-quote stars falls through to LLM', () => {
    const midQuote = LONG_MIDDLE.slice(0, 2000) +
      '\n\n"★★★★★ — Variety" said Variety.\n\n' +
      LONG_MIDDLE.slice(2000);
    const data = {
      outletId: 'nypost',
      outlet: 'New York Post',
      fullText: midQuote,
      _showCategory: 'broadway',
      llmScore: { score: 71, confidence: 'medium' },
      ensembleData: { ensembleSource: 'ensemble-majority' },
    };
    const stats = {};
    const result = getBestScore(data, { stats });
    assert.ok(result, 'should return LLM score');
    assert.strictEqual(result.source, 'llmScore');
    assert.strictEqual(result.score, 71);
    assert.ok(!stats.inlineStarRecovery, 'inline recovery must not fire');
  });
});

describe('inline-recovery LLM-conflict guard (P0 landmine 2 closed)', () => {
  test('high-conf LLM with opposite bucket overrides inline recovery', () => {
    const data = {
      outletId: 'nypost',
      outlet: 'New York Post',
      fullText: BYLINE_OPENER + LONG_MIDDLE,
      _showCategory: 'broadway',
      llmScore: { score: 30, confidence: 'high' },
      ensembleData: { ensembleSource: 'ensemble-majority' },
    };
    const stats = {};
    const flags = [];
    const result = getBestScore(data, { stats, flagForHumanReview: (d, reason, detail) => flags.push({ reason, detail }) });
    assert.ok(result, 'should return a score');
    assert.strictEqual(result.source, 'llmScore-override-inline-recovery-conflict');
    assert.strictEqual(result.score, 30);
    assert.strictEqual(stats.inlineRecoveryOverriddenByLLM, 1);
    assert.strictEqual(flags.length, 1);
    assert.strictEqual(flags[0].reason, 'inline-recovery-llm-conflict');
  });

  test('medium-conf LLM with opposite bucket does NOT override (flagged only)', () => {
    const data = {
      outletId: 'nypost',
      outlet: 'New York Post',
      fullText: BYLINE_OPENER + LONG_MIDDLE,
      _showCategory: 'broadway',
      llmScore: { score: 30, confidence: 'medium' },
      ensembleData: { ensembleSource: 'ensemble-majority' },
    };
    const stats = {};
    const flags = [];
    const result = getBestScore(data, { stats, flagForHumanReview: (d, reason, detail) => flags.push({ reason, detail }) });
    assert.strictEqual(result.source, 'originalScore-inline-recovery');
    assert.strictEqual(result.score, 60); // 3/5 stars = 60
    assert.strictEqual(flags.length, 1, 'still flags the conflict for human review');
  });

  test('same-bucket LLM + inline (both mid/tepid) — no conflict, no override', () => {
    const data = {
      outletId: 'nypost',
      outlet: 'New York Post',
      fullText: BYLINE_OPENER + LONG_MIDDLE,
      _showCategory: 'broadway',
      llmScore: { score: 55, confidence: 'high' },
      ensembleData: { ensembleSource: 'ensemble-majority' },
    };
    const stats = {};
    const flags = [];
    const result = getBestScore(data, { stats, flagForHumanReview: (d, reason, detail) => flags.push({ reason, detail }) });
    assert.strictEqual(result.source, 'originalScore-inline-recovery');
    assert.strictEqual(result.score, 60); // 3/5 stars = 60
    assert.strictEqual(flags.length, 0, 'same bucket — no flag');
  });
});
