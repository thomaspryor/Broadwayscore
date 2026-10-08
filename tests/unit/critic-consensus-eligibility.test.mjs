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
    // eligibleCount = min(review-texts count, live reviews.json count) since BRO-4852.
    assert.match(src, /isConsensusEligible\(eligibleCount\)/);
    assert.match(src, /Math\.min\(scoredReviews\.length, liveCounts\.get\(showId\)/);
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

  it('the check counts from reviewsDoc alone — never from the filesystem', () => {
    // WHY THIS IS A BEHAVIOUR TEST AND NOT A WORKFLOW-SOURCE TEST:
    // this used to assert that opening-night-checklist.yml does NOT run
    // checkout-review-texts, on the theory that data/review-texts/ is absent in
    // that job. BRO-234 (commit 4275723c6f0) deliberately ADDED that checkout —
    // 8 checks under scripts/lib/opening-night-checks/ read
    // context.reviewTextsRoot and were blind in CI without it. The workflow was
    // right and the assertion was stale, so it failed on main for days while
    // asserting the opposite of an intentional fix.
    //
    // The invariant that actually matters survives that change and any future
    // one: countScoredReviews is a pure function of the reviews array it is
    // handed. Whether review-texts happens to be on disk in some job must not
    // change this check's answer. Asserted by behaviour below, so re-plumbing
    // the workflow can never redden this test again.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', 'opening-night-checks', 'critics-take-present.check.js'),
      'utf8'
    );
    // Still load-bearing, and about the CHECK's own source, not a workflow's:
    // reaching for reviewTextsRoot here would reintroduce a disk-count source
    // whose answer depends on which job is running it.
    assert.doesNotMatch(src, /reviewTextsRoot/);

    const { countScoredReviews, run } = require(
      '../../scripts/lib/opening-night-checks/critics-take-present.check.js'
    );

    // Pure over its argument: the count comes from the array, nothing else.
    const scored = [
      { assignedScore: 80 },
      { compositeScore: 70 },
      { assignedScore: 90, wrongProduction: true }, // excluded
      { assignedScore: 90, wrongShow: true },       // excluded
      { fullText: 'unscored' },                     // excluded
    ];
    assert.equal(countScoredReviews(scored), MIN_SCORED_REVIEWS);
    assert.equal(countScoredReviews([]), 0);
    assert.equal(countScoredReviews(undefined), 0);

    // End to end through run(): a context carrying enough scored reviews must
    // reach the Critics-Take verdict, NOT the "below the floor" short-circuit.
    // If the check ever counted files on disk instead, this show would read as
    // 0 scored reviews here (this repo's data/review-texts is empty in a fresh
    // worktree) and the check would silently disable itself — the exact
    // site-wide failure the count-source rule exists to prevent.
    const context = {
      reviewsDoc: { 'test-show': scored },
      criticConsensusDoc: {},
      // deliberately no reviewTextsRoot key at all
    };
    const missing = run({ id: 'test-show', compositeScore: 75 }, context);
    assert.equal(missing.ok, false, 'must demand a Critics Take once the floor is met');
    assert.match(missing.message, /Critics Take is missing/);

    const present = run({ id: 'test-show', compositeScore: 75 }, {
      ...context,
      criticConsensusDoc: { 'test-show': { text: 'The critics broadly agreed.' } },
    });
    assert.equal(present.ok, true, 'a present Critics Take satisfies the check');

    // And below the floor it still abstains, from the same source.
    const below = run({ id: 'test-show', compositeScore: 75 }, {
      reviewsDoc: { 'test-show': [{ assignedScore: 80 }] },
      criticConsensusDoc: {},
    });
    assert.equal(below.ok, true, 'one scored review is below the floor — no Take expected');
    assert.match(below.message, new RegExp(`below the ${MIN_SCORED_REVIEWS}`));
  });
});

// BRO-4852: Midnight kept a Critics' Take about Ben Platt after its two
// wrong-show reviews left reviews.json; 25 shows held a blurb with fewer than
// two live reviews. Eligibility now also counts what the site shows.
it('staleConsensusIds: a blurb with fewer than MIN live reviews is stale, whatever its stored reviewCount', async () => {
  const { liveScoredCounts, staleConsensusIds } = await import('../../scripts/lib/critic-consensus-eligibility.js');
  const counts = liveScoredCounts({ reviews: [
    { showId: 'a', assignedScore: 80 }, { showId: 'a', assignedScore: 70 },
    { showId: 'b', assignedScore: 90 }, { showId: 'b', assignedScore: null },
  ] });
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 1);
  const stale = staleConsensusIds({
    a: { reviewCount: 2 }, b: { reviewCount: 1 }, midnight: { reviewCount: 3 },
  }, counts);
  assert.deepEqual(stale.sort(), ['b', 'midnight']);
  // Flagged rows do not count (critics-take-present.check.js rule).
  const flagged = liveScoredCounts({ reviews: [{ showId: 'c', assignedScore: 80, wrongShow: true }, { showId: 'c', compositeScore: 70 }] });
  assert.equal(flagged.get('c'), 1);
});

it('generate-critic-consensus skips the prune when it would delete more than MAX_STALE_PRUNE entries', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'generate-critic-consensus.js'), 'utf8');
  assert.match(src, /stale\.length > MAX_STALE_PRUNE/);
});

// The contamination audit read r.score, a field reviews.json rows never carry,
// so REVIEWCOUNT_DRIFT/MEANSCORE_DRIFT could never fire (BRO-4852).
it('audit-critic-consensus-contamination reads the score reviews.json actually carries', () => {
  const { reviewScore } = require('../../scripts/audit-critic-consensus-contamination.js');
  assert.equal(reviewScore({ assignedScore: 81 }), 81);
  assert.equal(reviewScore({ compositeScore: 70 }), 70);
  assert.equal(reviewScore({ assignedScore: null }), undefined);
});

// The generator now summarises only review texts whose outlet has a live row
// for the show; 858 inputs came from outlets the site excludes (BRO-4852).
it('liveOutletKeys lists show|outlet pairs the site shows, skipping flagged and unscored rows', () => {
  const { liveOutletKeys } = require('../../scripts/lib/critic-consensus-eligibility.js');
  const keys = liveOutletKeys({ reviews: [
    { showId: 's', outletId: 'nytimes', assignedScore: 80 },
    { showId: 's', outletId: 'vulture', assignedScore: null },
    { showId: 's', outletId: 'guardian', assignedScore: 70, wrongShow: true },
    { showId: 't', outletId: 'nytimes', compositeScore: 60 },
  ] });
  assert.deepEqual([...keys].sort(), ['s|nytimes', 't|nytimes']);
});

it('generate-critic-consensus filters texts to live outlets and parses replies through finalResponseText', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'generate-critic-consensus.js'), 'utf8');
  assert.match(src, /liveOutlets\.has\(`\$\{showId\}\|\$\{data\.outletId\}`\)/);
  assert.doesNotMatch(src, /content\[0\]\.text\.trim\(\)/);
});
