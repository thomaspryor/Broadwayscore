import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { anchorFallbackScore } = require('../../scripts/lib/anchor-fallback-score.js');
const { needsLateStarReanchor } = require('../../scripts/lib/late-star-anchor.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const review = (extra = {}) => ({ category: 'west-end', originalScore: '3/5 stars', originalScoreSource: 'unicode-stars', ...extra });
const scored = (score) => ({ assignedScore: score, llmScore: { score }, scoreSource: 'manual-cleared-haiku-fallback' });

test('clamps an out-of-band Haiku score into the star band and stamps llmScore.band', () => {
  const out = anchorFallbackScore(scored(77), review());
  assert.ok(out.llmScore.band, 'band stamped');
  assert.ok(out.assignedScore <= out.llmScore.band.ceiling && out.assignedScore >= out.llmScore.band.floor);
  assert.strictEqual(out.llmScore.score, out.assignedScore);
});

test('in-band score is unchanged but still stamped', () => {
  const out = anchorFallbackScore(scored(60), review());
  assert.strictEqual(out.assignedScore, 60);
  assert.ok(out.llmScore.band);
});

test('no star / non-anchored market: untouched', () => {
  assert.strictEqual(anchorFallbackScore(scored(77), review({ originalScore: undefined, originalScoreSource: undefined })).llmScore.band, undefined);
  assert.strictEqual(anchorFallbackScore(scored(77), review({ category: 'some-unanchored-market' })).llmScore.band, undefined);
});

test('anchored output no longer trips the detector predicate', () => {
  const rf = review({ scoreSource: 'llm-v6', llmScore: { score: 77 }, ensembleData: {} });
  const sc = anchorFallbackScore({ ...rf, ...scored(77) }, rf);
  assert.strictEqual(needsLateStarReanchor(sc, { category: 'west-end' }), null);
});

test('index.ts fallback path calls anchorFallbackScore', () => {
  const src = fs.readFileSync(path.join(here, '../../scripts/llm-scoring/index.ts'), 'utf8');
  assert.match(src, /anchorFallbackScore\(scoredAny, reviewFile\)/);
});
