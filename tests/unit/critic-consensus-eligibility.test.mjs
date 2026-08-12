/**
 * The Critics' Take floor, asserted from both sides (task #389).
 *
 * The point of this file is not that 2 >= 2. It is that the number the
 * opening-night check reads is the SAME number generate-critic-consensus.js
 * enforces — when those two drifted apart, the checklist dispatched a workflow
 * every day for a show the generator was coded to skip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const { MIN_SCORED_REVIEWS, isConsensusEligible } = require('../../scripts/lib/critic-consensus-eligibility.js');

describe('isConsensusEligible', () => {
  it('rejects below the floor', () => {
    for (let n = 0; n < MIN_SCORED_REVIEWS; n++) {
      assert.equal(isConsensusEligible(n), false, `${n} scored reviews must not be eligible`);
    }
  });

  it('accepts at and above the floor', () => {
    assert.equal(isConsensusEligible(MIN_SCORED_REVIEWS), true);
    assert.equal(isConsensusEligible(MIN_SCORED_REVIEWS + 5), true);
  });

  it('rejects non-numbers rather than coercing them', () => {
    for (const bad of [null, undefined, NaN, Infinity, '5']) {
      assert.equal(isConsensusEligible(bad), false, `${String(bad)} must not pass`);
    }
  });
});

describe('the floor is shared, not restated', () => {
  it('generate-critic-consensus.js imports the predicate instead of hardcoding a number', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'generate-critic-consensus.js'), 'utf8');
    assert.match(src, /from '\.\/lib\/critic-consensus-eligibility\.js'/);
    assert.match(src, /isConsensusEligible\(scoredReviews\.length\)/);
    // The literal this replaced. If someone reintroduces it the two sides can
    // drift again silently, which is exactly how the loop started.
    assert.doesNotMatch(src, /scoredReviews\.length\s*<\s*\d/);
  });

  it('critics-take-present.check.js imports the same predicate', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'opening-night-checks', 'critics-take-present.check.js'),
      'utf8'
    );
    assert.match(src, /require\('\.\.\/critic-consensus-eligibility'\)/);
    assert.match(src, /isConsensusEligible\(/);
  });

  it('the check does not read review-texts — that directory is absent in the checklist CI job', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'opening-night-checks', 'critics-take-present.check.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /reviewTextsRoot/);
    const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'opening-night-checklist.yml'), 'utf8');
    assert.doesNotMatch(wf, /checkout-review-texts/, 'if this job ever DOES check out review-texts, revisit the count source');
  });
});
