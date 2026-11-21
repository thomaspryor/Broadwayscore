// BRO-7519: a corrected URL and an old adjudication do not clear wrong-show content.
// Metadata shape from Sting's Guardian row; all body text below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const plan = require('../../data/pending-fixes/bro-7519-2.json');
const {
  cvFlagVetoedInWindow, explainExclusion, isIncludableForRebuild,
  isInWindowSlugMatchedReview,
} = require('../../scripts/lib/review-guards.js');

const show = {
  id: 'sting-off-west-end-2026', title: 'Sting', category: 'off-west-end', status: 'closed',
  openingDate: '2026-06-23', closingDate: '2026-07-18',
};

function review(extra = {}) {
  return {
    showId: show.id, outletId: 'guardian', outlet: 'The Guardian', criticName: 'Anya Ryan',
    url: 'https://www.theguardian.com/stage/2026/jun/24/sting-review-young-vic-theatre-london',
    publishDate: '2026-06-24',
    fullText: 'A fictional theatre review used only for a guard test. '.repeat(40),
    originalScore: '2/5 stars', originalScoreNormalized: 40, adjudicatedScore: 85,
    contentTier: 'invalid', contentTierReason: 'Wrong show', wrongShow: true,
    humanReviewedWrongShow: true,
    contentVerification: { isValid: false, wrongShow: true, wrongArticle: true, manualOverride: true },
    wrongProductionAutoCleared: 'rebuild: UK URL on London show (www.theguardian.com)',
    showNotMentioned: false, showNotMentionedManualClear: 'Only the show mention flag was cleared.',
    ...extra,
  };
}

test('BRO-7519: wrong-show content stays excluded despite the corrected URL, unrelated clears and adjudication', () => {
  const data = review();
  assert.equal(isInWindowSlugMatchedReview(data, show), true);
  // This is the helper used by the rebuild's inline wrongShow gate.
  assert.equal(cvFlagVetoedInWindow(data, show, 'wrongShow'), false);
  assert.equal(explainExclusion(data, show), 'wrongShow');
  assert.equal(isIncludableForRebuild(data, show), false);
});

test('the pending rating repair clears derived stars without releasing wrong-show content', () => {
  assert.equal(plan.plan.actions.length, 1);
  const [action] = plan.plan.actions;
  assert.equal(action.file, `${show.id}/guardian--anya-ryan.json`);
  const before = review();
  const result = applyReviewFieldEdit(before, action, { fixId: 'bro-7519-test', at: '2026-11-16T00:00:00Z' });
  assert.equal(result.ok, true, result.reason);
  const after = result.record;
  assert.equal(after.originalScore, null);
  assert.equal(after.originalScoreNormalized, null);
  assert.equal(after.originalScoreCleared, true);
  assert.equal(after.wrongShow, true);
  assert.equal(isIncludableForRebuild(after, show), false);
  assert.equal(isScoreable(after, show), false);
  assert.equal(before.originalScore, '2/5 stars', 'the executor returns a repaired copy');
});

test('an automated wrong-show verdict also stays excluded while its content tier is invalid', () => {
  const data = review({
    humanReviewedWrongShow: undefined, contentVerification: undefined,
    wrongShowReason: 'CV-promoted: wrong article',
  });
  assert.equal(cvFlagVetoedInWindow(data, show, 'wrongShow'), false);
  assert.equal(isIncludableForRebuild(data, show), false);
  // Removing the invalid tier restores the existing low-confidence veto.
  const retiered = { ...data, contentTier: 'complete', contentTierReason: 'Full review text' };
  assert.equal(cvFlagVetoedInWindow(retiered, show, 'wrongShow'), true);
  assert.equal(isIncludableForRebuild(retiered, show), true);
});

test('a human clear aimed at wrongShow still admits the review', () => {
  const data = review({ wrongShowManualClear: true });
  assert.equal(explainExclusion(data, show), null);
  assert.equal(isIncludableForRebuild(data, show), true);
});

test('a complete review without a wrong-show verdict remains includable', () => {
  const data = review({
    wrongShow: false, humanReviewedWrongShow: undefined, contentVerification: undefined,
    contentTier: 'complete', contentTierReason: 'Full review text',
  });
  assert.equal(explainExclusion(data, show), null);
  assert.equal(isIncludableForRebuild(data, show), true);
});
