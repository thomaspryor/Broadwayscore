/**
 * Unit tests for reconcileProtectedFields in
 * scripts/lib/restore-protected-fields.js — specifically the stale-checkout
 * (remote-richer) direction added after the Trainspotting The Stage incident
 * (review-texts 7f3cac6c75b, 2026-07-23):
 *
 * A collect-review-texts checkpoint job running on a checkout taken BEFORE the
 * opening-night poller collected + scored the review rebased with `-X theirs`
 * and its stale stub won over origin's fully-collected file. 751 words of
 * review text, an LLM score of 38, and the star rating were wiped 14 minutes
 * after they landed. The pre-existing ORIG_HEAD restore (Titanique fix) cannot
 * help in that direction — the stale version IS ours.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { reconcileProtectedFields } = require('../../scripts/lib/restore-protected-fields.js');

const RICH_TEXT = 'Tame, meandering show robs the cult classic of its jagged wit. '.repeat(12); // > 100 chars

function richRemote() {
  return {
    outletId: 'thestage',
    criticName: 'Sam Marlowe',
    fullText: RICH_TEXT,
    isFullReview: true,
    textWordCount: 751,
    textStatus: 'complete',
    contentTier: 'complete',
    tierReason: 'Full review text',
    assignedScore: 38,
    llmScore: { score: 38, confidence: 'high' },
    originalScore: '2/5 stars',
    originalScoreNormalized: 40,
    originalScoreSource: 'stage-star-svg',
    scoreSource: 'anchored-v6',
    contentVerification: { isValid: true, confidence: 'high' },
  };
}

function staleLocalStub() {
  return {
    outletId: 'thestage',
    criticName: 'Sam Marlowe',
    fullText: '',
    contentTier: 'stub',
    theatreReviewsStars: '2/5',
  };
}

describe('stale-checkout guard: remote richer than post-rebase local', () => {
  test('restores fullText, content fields, and scoring from remote (Trainspotting Stage fixture)', () => {
    const local = staleLocalStub();
    const { modified, notes } = reconcileProtectedFields(local, richRemote(), staleLocalStub(), { staleCheckoutGuard: true });
    assert.equal(modified, true);
    assert.equal(local.fullText, RICH_TEXT);
    assert.equal(local.contentTier, 'complete');
    assert.equal(local.textWordCount, 751);
    assert.equal(local.assignedScore, 38);
    assert.equal(local.llmScore.score, 38);
    assert.equal(local.originalScore, '2/5 stars');
    assert.ok(notes.some(n => n.includes('stale-checkout guard')));
  });

  test('does NOT restore when local emptiness is an intentional URL-change clear', () => {
    const local = {
      ...staleLocalStub(),
      _urlChangedClear: {
        clearedAt: '2026-07-01T00:00:00Z',
        cleared: ['fullText', 'assignedScore', 'originalScore'],
        reason: 'url moved to different canonical article',
      },
    };
    const before = JSON.stringify(local);
    reconcileProtectedFields(local, richRemote(), null, { staleCheckoutGuard: true });
    assert.equal(local.fullText, '', 'cleared fullText must stay cleared');
    assert.equal(local.assignedScore, undefined, 'cleared score must stay cleared');
    // (other MANUAL_FIELDS restores may still fire; content/score must not)
    assert.ok(!JSON.parse(JSON.stringify(local)).llmScore, 'llmScore must not be resurrected');
    void before;
  });

  test('does NOT overwrite a local body that is already richer than remote', () => {
    const localRicher = RICH_TEXT + ' Plus an extra closing paragraph the remote never had.';
    const local = { ...staleLocalStub(), fullText: localRicher, contentTier: 'complete' };
    reconcileProtectedFields(local, richRemote(), null, { staleCheckoutGuard: true });
    assert.equal(local.fullText, localRicher);
  });

  test('does NOT copy remote scores onto a DIFFERENT local body', () => {
    const local = {
      ...staleLocalStub(),
      fullText: 'A completely different freshly-collected body. '.repeat(10),
      contentTier: 'complete',
    };
    const remote = richRemote();
    remote.fullText = 'short remote body';
    reconcileProtectedFields(local, remote, null, { staleCheckoutGuard: true });
    assert.equal(local.assignedScore, undefined, 'scores describe a body the local does not have');
    assert.equal(local.llmScore, undefined);
  });

  test('does NOT clobber an existing local score', () => {
    const local = { ...staleLocalStub(), fullText: RICH_TEXT, assignedScore: 55, llmScore: { score: 55 } };
    reconcileProtectedFields(local, richRemote(), null, { staleCheckoutGuard: true });
    assert.equal(local.assignedScore, 55);
    assert.equal(local.llmScore.score, 55);
  });
});

describe('pre-existing directions still work', () => {
  test('ORIG_HEAD (ours) richer text still restored (Titanique fix)', () => {
    const local = staleLocalStub();
    const remote = staleLocalStub(); // remote also stale
    const ours = { ...staleLocalStub(), fullText: RICH_TEXT };
    reconcileProtectedFields(local, remote, ours);
    assert.equal(local.fullText, RICH_TEXT);
  });

  test('manual wrongProduction:false from ours beats local true', () => {
    const local = { ...staleLocalStub(), wrongProduction: true };
    const ours = { ...staleLocalStub(), wrongProduction: false };
    reconcileProtectedFields(local, staleLocalStub(), ours);
    assert.equal(local.wrongProduction, false);
  });

  test('humanReviewScore restored from remote when missing locally', () => {
    const local = staleLocalStub();
    const remote = { ...staleLocalStub(), humanReviewScore: 72 };
    reconcileProtectedFields(local, remote, null);
    assert.equal(local.humanReviewScore, 72);
  });
});

describe('staleCheckoutGuard gating (batch-correct-reviews ORIG_HEAD caller)', () => {
  test('without the flag, remote-richer content/scores are NOT restored', () => {
    const local = staleLocalStubForGate();
    reconcileProtectedFields(local, richRemoteForGate(), null);
    assert.equal(local.fullText, '', 'pre-correction body must not be resurrected');
    assert.equal(local.assignedScore, undefined, 'pre-correction score must not be resurrected');
  });
  test('MANUAL_FIELDS restore still works without the flag', () => {
    const local = staleLocalStubForGate();
    const remote = { ...staleLocalStubForGate(), humanReviewScore: 72 };
    reconcileProtectedFields(local, remote, null);
    assert.equal(local.humanReviewScore, 72);
  });
});

function richRemoteForGate() {
  return { fullText: 'Rich body text. '.repeat(20), assignedScore: 38, llmScore: { score: 38 }, contentTier: 'complete' };
}
function staleLocalStubForGate() {
  return { fullText: '', contentTier: 'stub' };
}

describe('CV never restored wholesale via score restore (human-clear safety)', () => {
  test('remote cv.wrongProduction:true is NOT copied onto a human-cleared local', () => {
    const local = {
      fullText: '',
      contentTier: 'stub',
      wrongProduction: false,
      wrongProductionManualClear: true,
    };
    const remote = {
      fullText: 'Rich remote body. '.repeat(20),
      assignedScore: 40,
      llmScore: { score: 40 },
      contentVerification: { isValid: false, wrongProduction: true },
      flaggedForReview: true,
      flagReason: 'stale classifier verdict',
    };
    reconcileProtectedFields(local, remote, null, { staleCheckoutGuard: true });
    assert.equal(local.assignedScore, 40, 'score restore itself should fire');
    const cvWp = local.contentVerification && local.contentVerification.wrongProduction;
    assert.notEqual(cvWp, true, 'cv.wrongProduction must not be resurrected past a manual clear');
    assert.notEqual(local.flaggedForReview, true, 'flaggedForReview must not ride along with scores');
  });
});
