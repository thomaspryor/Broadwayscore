// BRO-5295 ratchet: a script that writes an extracted rating must say what it does with a
// deliberately cleared one (originalScoreCleared). The collector pre-pass did not, and
// re-added a phantom 2/5 the day after a fix cleared it. Writers may delegate to
// setExtractedScore, whose clear guard is exercised below (BRO-5296).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setExtractedScore } = require('./score-routing');

test('the shared writer refuses a cleared outlet rating without mutating the record', () => {
  for (const reason of [undefined, 'human: wrong show', 'extraction-no-evidence-in-text']) {
    for (const source of ['numeric-stars', 'json-ld', 'letter-grade', 'guardian-api']) {
      const data = {
        originalScore: null, originalScoreNormalized: null, originalScoreSource: null,
        originalScoreCleared: true, originalScoreClearedReason: reason,
        scoreSource: 'llm-v6', assignedScore: 87, humanReviewScore: 87,
      };
      const before = structuredClone(data);
      const routed = setExtractedScore(data, { value: '2/5 stars', normalizedValue: 40, source });
      assert.deepEqual(routed, { field: 'blocked', wasAggregator: true, blocked: true });
      assert.deepEqual(data, before, `${source}: ${reason}`);
    }
  }
});

test('a structural star only supersedes clears about missing rating evidence', () => {
  for (const source of ['timeout-svg-stars', 'londontheatre-page-json']) {
    for (const reason of ['extraction-no-evidence-in-text', 'outlet-publishes-no-critic-rating']) {
      const data = { originalScoreCleared: true, originalScoreClearedReason: reason };
      const routed = setExtractedScore(data, { value: '4/5 stars', normalizedValue: 80, source });
      assert.deepEqual(routed, { field: 'originalScore', wasAggregator: false });
      assert.equal(data.originalScore, '4/5 stars');
      assert.equal(data.originalScoreNormalized, 80);
      assert.equal(data.originalScoreSource, source);
      assert.equal(data.originalScoreCleared, undefined);
      assert.equal(data.originalScoreClearSupersededBy, source);
      assert.equal(data.originalScoreClearSupersededReason, reason);
    }
    for (const reason of [undefined, 'human: wrong show', 'aggregator-score-in-p0-slot']) {
      const data = { originalScoreCleared: true, originalScoreClearedReason: reason };
      const before = structuredClone(data);
      assert.equal(setExtractedScore(data, { value: '4/5 stars', normalizedValue: 80, source }).blocked, true);
      assert.deepEqual(data, before);
    }
  }
});

test('a cleared outlet rating still allows aggregator metadata without retiring the clear', () => {
  for (const [source, scoreSource] of [['lbo-css-stars', 'llm-v6'], ['json-ld', 'show-score-stars']]) {
    const data = {
      originalScore: null, originalScoreNormalized: null, originalScoreSource: null,
      originalScoreCleared: true, originalScoreClearedReason: 'human: wrong show', scoreSource,
    };
    const before = structuredClone(data);
    const routed = setExtractedScore(data, { value: '4/5 stars', normalizedValue: 80, source });
    assert.deepEqual(routed, { field: 'aggregatorStars', wasAggregator: true });
    assert.deepEqual(data, {
      ...before, aggregatorStars: '4/5 stars', aggregatorStarsNormalized: 80, aggregatorStarsSource: source,
    });
  }
});

test('absent and false clear flags still allow outlet scores', () => {
  for (const data of [{}, { originalScoreCleared: false }]) {
    assert.deepEqual(setExtractedScore(data, { value: 'B+', normalizedValue: 85, source: 'letter-grade' }),
      { field: 'originalScore', wasAggregator: false });
    assert.equal(data.originalScore, 'B+');
    assert.equal(data.originalScoreNormalized, 85);
    assert.equal(data.originalScoreSource, 'letter-grade');
  }
});

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITES = /\b(?:extractScore|setExtractedScore|extractExplicitScore|runScoreExtractorPrePass)\(/;
const HONOURS = /originalScoreCleared|existingHasScoreSignal|existingRatingCleared|isIntentionalClear|persistReviewSnapshot|\bsetExtractedScore\(/;
// These return extraction results without writing a review record. Their callers
// own the write and must pass the same guard scan as every other writer.
const DEFINERS = new Set([
  'score-extractors.js', 'score-routing.js', 'score-extractor-prepass.js',
  'llm-score-extractor.js', 'recover-manual-review-score.js',
]);

const KNOWN_UNGUARDED = new Set([]);

function writers() {
  const out = [];
  for (const dir of ['', 'lib']) {
    for (const f of fs.readdirSync(path.join(SCRIPTS, dir))) {
      if (!f.endsWith('.js') || DEFINERS.has(f) || /\.test\./.test(f) || /^test-/.test(f)) continue;
      const rel = dir ? `${dir}/${f}` : f;
      const src = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8');
      if (WRITES.test(src)) out.push({ rel, honours: HONOURS.test(src) });
    }
  }
  return out;
}

test('every script that writes an extracted rating handles a cleared rating, or is on the shrinking backlog', () => {
  const w = writers();
  assert.ok(w.length > 20, `scan found only ${w.length} writers; the pattern is stale`);
  const newOffenders = w.filter((x) => !x.honours && !KNOWN_UNGUARDED.has(x.rel)).map((x) => x.rel);
  assert.deepEqual(newOffenders, [], `these scripts write ratings without checking originalScoreCleared: ${newOffenders.join(', ')}`);
});

test('backlog entries that now honour a cleared rating are removed from KNOWN_UNGUARDED', () => {
  const byRel = new Map(writers().map((x) => [x.rel, x]));
  const stale = [...KNOWN_UNGUARDED].filter((rel) => !byRel.has(rel) || byRel.get(rel).honours);
  assert.deepEqual(stale, [], `remove from KNOWN_UNGUARDED: ${stale.join(', ')}`);
});
