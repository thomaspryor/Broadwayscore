import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/critics-take-present.check.js');
const { MIN_SCORED_REVIEWS } = require('../../scripts/lib/critic-consensus-eligibility.js');

// Enough scored reviews that the consensus generator would actually run, so
// these fixtures exercise the missing-Critics-Take branch rather than the
// below-threshold skip. Built from MIN_SCORED_REVIEWS so raising the floor in
// generate-critic-consensus.js does not quietly turn these into skip cases.
function scoredReviews(n = MIN_SCORED_REVIEWS) {
  return Array.from({ length: n }, (_, i) => ({ outletId: `outlet-${i}`, assignedScore: 70 + i }));
}

function makeContext(criticConsensusDoc = {}, reviews = scoredReviews()) {
  return {
    reviewsDoc: { 'test-2026': reviews },
    reviewTextsRoot: '/tmp',
    driftState: {},
    criticConsensusDoc,
    now: new Date(),
  };
}

describe('critics-take-present check', () => {
  it('compositeScore exists + criticConsensusDoc has summary → ok', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({ 'test-2026': { text: 'Critics loved it.' } });
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('compositeScore exists + show missing from criticConsensusDoc → warning', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({});
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /Critics Take is missing/);
    assert.match(result.message, /generate-critic-consensus/);
  });

  it('compositeScore exists + summary is empty string → warning', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({ 'test-2026': { text: '' } });
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
  });

  it('compositeScore is null → ok (not yet scoreable)', () => {
    const show = { id: 'test-2026', compositeScore: null };
    const context = makeContext({});
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });
});

// The 2026-08-09 production loop: death-note-the-musical-west-end-2026 carried
// composite 44 off ONE scored review. The check demanded a Critics Take,
// dispatched update-critic-consensus.yml, and generate-critic-consensus.js
// skipped the show for being under its own 2-scored-review floor — 5 dispatches
// and 23 escalations in data/audit/remediation-log.jsonl before it was caught.
describe('critics-take-present respects the generator threshold (task #389)', () => {
  it('one scored review → ok, and NO remediation is declared', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const context = makeContext({}, scoredReviews(1));
    const result = check.run(show, context);
    assert.equal(result.ok, true, 'a show the generator would skip is not a gap');
    assert.equal(result.severity, 'ok');
    assert.match(result.message, /Only 1 scored review/);
    assert.match(result.message, new RegExp(`below the ${MIN_SCORED_REVIEWS}`));
    assert.equal(result.details?.remediation, undefined, 'nothing to dispatch — the generator would refuse');
  });

  it('zero scored reviews → ok (the composite came from somewhere else)', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const context = makeContext({}, []);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.details?.remediation, undefined);
  });

  it('at the threshold → still flags, and still declares the workflow remediation', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const context = makeContext({}, scoredReviews(MIN_SCORED_REVIEWS));
    const result = check.run(show, context);
    assert.equal(result.ok, false, 'the fix must not silence the real gap');
    assert.equal(result.details.remediation.workflow, 'update-critic-consensus.yml');
    assert.equal(result.details.remediation.key, 'critic-consensus:test-2026');
  });

  it('excluded reviews do not count toward the threshold', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const reviews = [
      { outletId: 'a', assignedScore: 70 },
      { outletId: 'b', assignedScore: 65, wrongProduction: true },
      { outletId: 'c', assignedScore: 60, wrongShow: true },
    ];
    const result = check.run(show, makeContext({}, reviews));
    assert.equal(result.ok, true, 'only 1 of the 3 is usable — below the floor');
    assert.match(result.message, /Only 1 scored review/);
  });

  it('counts compositeScore-bearing entries too, not just assignedScore', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const reviews = [
      { outletId: 'a', assignedScore: null, compositeScore: 70 },
      { outletId: 'b', assignedScore: null, compositeScore: 65 },
    ];
    const result = check.run(show, makeContext({}, reviews));
    assert.equal(result.ok, false, 'two scored reviews by either field clears the floor');
  });

  it('unscored reviews never clear the floor no matter how many there are', () => {
    const show = { id: 'test-2026', compositeScore: 44 };
    const reviews = Array.from({ length: 10 }, (_, i) => ({ outletId: `o${i}`, assignedScore: null, compositeScore: null }));
    const result = check.run(show, makeContext({}, reviews));
    assert.equal(result.ok, true);
    assert.match(result.message, /Only 0 scored review/);
  });

  it('a show absent from reviewsDoc entirely does not throw', () => {
    const show = { id: 'not-in-doc-2026', compositeScore: 44 };
    const result = check.run(show, makeContext({}));
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });
});

describe('countScoredReviews', () => {
  it('handles undefined (show not in reviewsDoc)', () => {
    assert.equal(check.countScoredReviews(undefined), 0);
  });

  it('handles an empty array', () => {
    assert.equal(check.countScoredReviews([]), 0);
  });

  it('counts only usable scored entries', () => {
    const reviews = [
      { assignedScore: 80 },
      { compositeScore: 75 },
      { assignedScore: 70, wrongProduction: true },
      { assignedScore: 70, wrongShow: true },
      { assignedScore: null, compositeScore: null },
    ];
    assert.equal(check.countScoredReviews(reviews), 2);
  });
});
