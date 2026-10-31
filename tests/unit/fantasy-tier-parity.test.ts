/**
 * The fantasy scripts map scores to tiers with a JS copy of the site's
 * thresholds (scripts/lib/fantasy-helpers.js). Pin that copy to the real
 * site functions so a threshold change in src/ fails here instead of
 * silently mis-pricing or mis-scoring shows in the weekly pipeline.
 *
 * Run with: npx tsx --test tests/unit/fantasy-tier-parity.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { getCriticLabel } from '../../src/config/scoring';
import { getAudienceGrade } from '../../src/lib/audience-grade-utils';

const require = createRequire(import.meta.url);
const { criticLabelForScore, audienceGradeForScore } = require('../../scripts/lib/fantasy-helpers.js');

describe('script tier mappers match the site', () => {
  test('critic label agrees for every integer score 0..100 and the half points', () => {
    for (let s = 0; s <= 100; s += 0.5) {
      assert.equal(criticLabelForScore(s), getCriticLabel(s), `score ${s}`);
    }
  });

  test('audience grade agrees for every integer score 0..100 and the half points', () => {
    for (let s = 0; s <= 100; s += 0.5) {
      assert.equal(audienceGradeForScore(s), getAudienceGrade(s).grade, `score ${s}`);
    }
    assert.equal(audienceGradeForScore(null), null);
  });
});
