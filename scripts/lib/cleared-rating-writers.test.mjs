// BRO-5295 ratchet: a script that writes an extracted rating must say what it does with a
// deliberately cleared one (originalScoreCleared). The collector pre-pass did not, and
// re-added a phantom 2/5 the day after a fix cleared it. New writers must check; the
// KNOWN_UNGUARDED list below is the backlog (BRO-5296) and may only shrink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITES = /\b(?:extractScore|setExtractedScore|extractExplicitScore|runScoreExtractorPrePass)\(/;
const HONOURS = /originalScoreCleared|existingHasScoreSignal|existingRatingCleared|isIntentionalClear|persistReviewSnapshot/;
const DEFINERS = new Set(['score-extractors.js', 'score-routing.js', 'score-extractor-prepass.js']);

const KNOWN_UNGUARDED = new Set([
  'extract-explicit-ratings.js', 'fetch-guardian-reviews.js', 'fetch-nysr-scores.js', 'fix-default-scores.js',
  'fix-nysr-scores.js', 'lib/llm-score-extractor.js', 'lib/recover-manual-review-score.js', 'migrate-numeric-scores.js',
  'recover-serp-text.js', 'recover-wayback-reviews.js', 'retry-pending-scores.js',
  'score-all-unscored.js', 'scrape-nysr-reviews.js', 'scrape-wp-theater-blogs.js', 'verify-showscore-stars.js',
]);

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
