/**
 * Regression test for BRO-372 (T1/T2 review stuck >24h: Trainspotting the
 * musical — broadwayworld--team-bww.json).
 *
 * The BroadwayWorld page at this file's URL is a promo/casting-update page
 * for the show, not a review — confirmed by two rounds of independent
 * investigation (BRO-276, then a 2026-08-26 manual web search: no dedicated
 * BroadwayWorld review of this West End production exists). Re-fetching the
 * same URL can never produce a review that was never published, so the fix
 * is NOT to make the file "successfully fetched and processed" into a score
 * — it is to make the ensemble correctly record its already-correct verdict
 * as the terminal 'not_a_review' editorial exclusion instead of the
 * retriable 'garbage_text' fetch-quality label, so t1-silent-gap.js's >24h
 * backstop stops re-alerting on a file that can never be "resolved".
 *
 * Root cause: ensemble-scorer.ts combineOutcomes() took rejections[0]'s
 * literal `rejection` type on a >=2-model consensus, rather than reconciling
 * disagreement between models. On 2026-09-05 openai and gemini both rejected
 * this exact text with reasoning that describes not_a_review content
 * (promotional/casting copy, no critical evaluation) — but openai (first in
 * Promise.all push order: claude, openai, gemini, kimi) had itself labeled
 * its `rejection` field 'garbage_text', so the ensemble recorded
 * rejectionReason: 'garbage_text', which t1-silent-gap.js's
 * EDITORIAL_REJECTIONS set does not treat as terminal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { EnsembleReviewScorer, pickConsensusRejection } = require('../../scripts/llm-scoring/ensemble-scorer');
const { classifySilentGap } = require('../../scripts/lib/t1-silent-gap');

// Verbatim rejectionReasoning strings from the live file
// (broadway-review-texts/trainspotting-the-musical-west-end-2026/broadwayworld--team-bww.json)
// at the 2026-09-05 rejection that triggered BRO-372.
const OPENAI_REASONING =
  'The text is primarily promotional content with navigation prompts and lacks a coherent review or evaluative content.';
const GEMINI_REASONING =
  "The text is a collection of promotional blurbs, plot summaries, and casting updates, not a critical evaluation of the show's quality. It contains no clear critical opinion or recommendation.";

describe('BRO-372: ensemble rejection-type consensus', () => {
  it('pickConsensusRejection prefers the specific not_a_review verdict over the generic garbage_text label on a 1-vs-1 split', () => {
    const rejections = [
      { model: 'openai', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: OPENAI_REASONING },
      { model: 'gemini', result: null, rejected: true, rejection: 'not_a_review', rejectionReasoning: GEMINI_REASONING },
    ];
    const picked = pickConsensusRejection(rejections);
    assert.strictEqual(picked.rejection, 'not_a_review');
  });

  it('a strict majority on garbage_text still wins (2 of 3 models genuinely agree it is garbage)', () => {
    const rejections = [
      { model: 'claude', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: 'blank page' },
      { model: 'openai', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: 'nav-only content' },
      { model: 'gemini', result: null, rejected: true, rejection: 'not_a_review', rejectionReasoning: GEMINI_REASONING },
    ];
    const picked = pickConsensusRejection(rejections);
    assert.strictEqual(picked.rejection, 'garbage_text');
  });

  // Codex ship-check finding on this same fix: a 4-model ensemble split
  // garbage_text×2 / wrong_show×1 / wrong_production×1 has no strict
  // majority, but garbage_text still has the actual PLURALITY (most votes).
  // A blind priority scan (the first version of this fix) would pick
  // wrong_show — a type only ONE model named — over a type two independent
  // models converged on. Priority may only break ties among types tied for
  // the plurality; it must never override an outright vote-count lead.
  it('plurality beats priority: garbage_text with 2 votes beats wrong_show/wrong_production with 1 vote each', () => {
    const rejections = [
      { model: 'claude', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: 'blank page' },
      { model: 'openai', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: 'nav-only content' },
      { model: 'gemini', result: null, rejected: true, rejection: 'wrong_show', rejectionReasoning: 'different show entirely' },
      { model: 'kimi', result: null, rejected: true, rejection: 'wrong_production', rejectionReasoning: 'different staging' },
    ];
    const picked = pickConsensusRejection(rejections);
    assert.strictEqual(picked.rejection, 'garbage_text');
  });

  it('priority breaks a true tie among types tied for the plurality (1-vote-each 3-way split)', () => {
    const rejections = [
      { model: 'claude', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: 'blank page' },
      { model: 'openai', result: null, rejected: true, rejection: 'wrong_show', rejectionReasoning: 'different show' },
      { model: 'gemini', result: null, rejected: true, rejection: 'not_a_review', rejectionReasoning: GEMINI_REASONING },
    ];
    // All three types have exactly 1 vote — priority order picks wrong_show.
    const picked = pickConsensusRejection(rejections);
    assert.strictEqual(picked.rejection, 'wrong_show');
  });

  it('combineOutcomes on the exact BRO-372 2-model consensus records not_a_review, not garbage_text', () => {
    const scorer = new EnsembleReviewScorer('fake-claude-key', 'fake-openai-key');
    const results = [
      { model: 'claude', result: null, error: 'not called for this scenario' },
      { model: 'openai', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: OPENAI_REASONING },
      { model: 'gemini', result: null, rejected: true, rejection: 'not_a_review', rejectionReasoning: GEMINI_REASONING },
    ];
    const combined = scorer.combineOutcomes(results);
    assert.strictEqual(combined.rejected, true);
    assert.strictEqual(combined.rejection, 'not_a_review');
    assert.match(combined.rejectionReasoning, /openai:/);
    assert.match(combined.rejectionReasoning, /gemini:/);
    // Ship-check finding: only ONE of the two rejecting models (gemini)
    // actually named not_a_review — wrong-production-autoclear.js's
    // hasEnsembleConsensus() must see rejectionAgreeCount=1, not 2, or it
    // will over-count this as real 2-model agreement.
    assert.strictEqual(combined.rejectionAgreeCount, 1);
  });

  it('naively taking rejections[0] (the pre-fix behavior) would have picked garbage_text — confirms the bug this test guards against', () => {
    const rejections = [
      { model: 'openai', result: null, rejected: true, rejection: 'garbage_text', rejectionReasoning: OPENAI_REASONING },
      { model: 'gemini', result: null, rejected: true, rejection: 'not_a_review', rejectionReasoning: GEMINI_REASONING },
    ];
    assert.strictEqual(rejections[0].rejection, 'garbage_text');
  });

  it('rejectionReason not_a_review is a terminal editorial exclusion in t1-silent-gap (the >24h backstop never re-fires)', () => {
    const file = {
      rejectedAt: '2026-09-05T20:22:39.350Z',
      rejectedBy: 'ensemble-scoreability-check',
      rejectionReason: 'not_a_review',
      contentTier: 'invalid',
    };
    const gap = classifySilentGap({
      file,
      show: {},
      tier: 2,
      outletScored: false,
      now: new Date('2026-09-08T00:00:00Z'),
    });
    assert.strictEqual(gap, null, 'not_a_review must be a terminal exclusion, never an escalatable gap');
  });

  it('the same file misclassified as garbage_text WOULD have kept re-alerting forever (regression guard for the bug BRO-372 filed on)', () => {
    const file = {
      rejectedAt: '2026-09-05T20:22:39.350Z',
      rejectedBy: 'ensemble-scoreability-check',
      rejectionReason: 'garbage_text',
      contentTier: 'invalid',
    };
    const gap = classifySilentGap({
      file,
      show: {},
      tier: 2,
      outletScored: false,
      now: new Date('2026-09-08T00:00:00Z'),
    });
    assert.deepStrictEqual(gap, { type: 'rejected-unscoreable', recoverable: false });
  });

  // Codex ship-check finding: ModelOutcome.rejection is optional. If every
  // rejecting model somehow omits it, `r.rejection === primaryRejection.rejection`
  // would compare undefined === undefined and misreport agreeCount as if
  // every model had confidently named the same (nonexistent) type.
  it('agreeCount is 0, not rejections.length, when no rejecting model reported a type at all', () => {
    const scorer = new EnsembleReviewScorer('fake-claude-key', 'fake-openai-key');
    const results = [
      { model: 'claude', result: null, error: 'not called for this scenario' },
      { model: 'openai', result: null, rejected: true, rejectionReasoning: 'rejected but type missing' },
      { model: 'gemini', result: null, rejected: true, rejectionReasoning: 'also rejected, also no type' },
    ];
    const combined = scorer.combineOutcomes(results);
    assert.strictEqual(combined.rejected, true);
    assert.strictEqual(combined.rejectionAgreeCount, 0);
  });
});
