/**
 * BRO-2407 acceptance: fullText added / wrongProduction cleared must flag
 * needsRescore ONLY when the file was scored from an excerpt and is
 * isScoreable(); never-scored or unscoreable files must not get an unneeded
 * rescore flag. Detailed cases live in rescore-flagging.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { isStaleScoreInput, markRescoreNeeded } = require(path.join(REPO, 'scripts/lib/rescore-flagging.js'));

const scoredOnExcerpt = (over = {}) => ({
  assignedScore: 72,
  llmMetadata: { textSource: { type: 'excerpt' } },
  contentTier: 'complete',
  fullText: 'x'.repeat(2000),
  ...over,
});

test('excerpt-scored file that gained fullText is flagged for rescore', () => {
  const d = scoredOnExcerpt();
  assert.equal(isStaleScoreInput(d), true);
  markRescoreNeeded(d, 'fullText added after excerpt-based score');
  assert.equal(d.needsRescore, true);
});

test('never-scored file gets no unneeded rescore flag', () => {
  assert.equal(isStaleScoreInput(scoredOnExcerpt({ assignedScore: undefined })), false);
});

test('unscoreable file (still wrongProduction) gets no unneeded rescore flag', () => {
  assert.equal(isStaleScoreInput(scoredOnExcerpt({ wrongProduction: true })), false);
});
