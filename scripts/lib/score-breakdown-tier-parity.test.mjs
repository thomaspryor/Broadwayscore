/**
 * Guard: the breakdown bar (Rave / Positive / Mixed / Negative) never disagrees
 * with the badge colors. Billy Crystal 860 showed two blue badges (74, 69) while
 * the bar counted one as Positive and the other as Mixed, because the bar used a
 * hard-coded 70 cutoff. Every integer score, every market, must map consistently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { getBreakdownTierId, getScoreTierId, getReviewBreakdownTierId, parseVerdictTierId } = require('./score-tiers.js');

const BAR_FOR_BADGE = {
  'must-see': 'rave',
  recommended: 'positive',
  'worth-seeing': 'positive',
  skippable: 'mixed',
  'stay-away': 'negative',
};

for (const market of [undefined, 'broadway', 'west-end', 'off-west-end']) {
  test(`bar tier matches badge band for every score (${market ?? 'default'})`, () => {
    for (let s = 0; s <= 100; s++) {
      assert.equal(getBreakdownTierId(s, market), BAR_FOR_BADGE[getScoreTierId(s, market)], `score ${s}`);
    }
  });
}

test('both blue badges (69 and 74) land in the same bar bucket', () => {
  assert.equal(getBreakdownTierId(74), 'positive');
  assert.equal(getBreakdownTierId(69), 'positive');
  assert.equal(getBreakdownTierId(64), 'mixed');
});

test('rounds like the badge and rejects non-finite scores', () => {
  assert.equal(getBreakdownTierId(64.6), 'positive');
  assert.equal(getBreakdownTierId(null), null);
  assert.equal(getBreakdownTierId(NaN), null);
});

test('no hard-coded 70 cutoff returns to the bar or the broadcast', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const f of ['src/components/show-cards/ScoreBreakdownBar.tsx', 'scripts/send-opening-night-broadcast.js', 'scripts/lib/reddit-opening-post.js', 'scripts/social-autopost/run.js']) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /(rounded|score|r)\s*>=\s*70\b/, `${f} must use getBreakdownTierId`);
  }
});

test('verdict wins over the score band; no verdict falls back to the band (BRO-6686)', () => {
  assert.equal(getReviewBreakdownTierId('mixed', 67), 'mixed'); // Vulture on The Heart: 67 reads Positive by score
  assert.equal(getReviewBreakdownTierId('Mixed', 53), 'mixed'); // Culture Sauce: 53 reads Negative by score
  assert.equal(getReviewBreakdownTierId('pan', 90), 'negative');
  assert.equal(getReviewBreakdownTierId(null, 67), 'positive');
  assert.equal(getReviewBreakdownTierId(undefined, 53), 'negative');
  assert.equal(getReviewBreakdownTierId('bogus', 91), 'rave');
  assert.equal(getReviewBreakdownTierId(null, null), null);
});

test('parseVerdictTierId reads the ensemble majority from modelAgreement', () => {
  assert.equal(parseVerdictTierId('All 3 models agree: Rave'), 'rave');
  assert.equal(parseVerdictTierId('2/3 models agree: Mixed'), 'mixed');
  assert.equal(parseVerdictTierId('Both models agree: Positive'), 'positive');
  assert.equal(parseVerdictTierId('Bucket disagreement: claude=Mixed, openai=Positive'), null);
  assert.equal(parseVerdictTierId(null), null);
});
