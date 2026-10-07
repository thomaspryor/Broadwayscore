import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isStaleAutomatedTextVerdict,
  staleAutomatedTextVerdicts,
  neutralizeStaleAutomatedTextVerdict,
  isHumanRejecter,
} = require('./stale-automated-text-verdict.js');
const { isIncludableForRebuild, explainExclusion, rejectedAtHumanCleared } = require('./review-guards.js');

const BODY = 'The production is a triumph of staging. '.repeat(60); // ~2400 chars

// Shape of a-time-to-kill-2013/nytimes--charles-isherwood.json: garbage_text
// verdict on an old paywall scrape, real review re-fetched later.
function staleRejection(over = {}) {
  return {
    showId: 'x-2013', outletId: 'nytimes', criticName: 'Charles Isherwood',
    url: 'https://www.nytimes.com/2013/10/21/theater/reviews/x.html',
    fullText: BODY, contentTier: 'complete',
    rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'garbage_text',
    rejectionReasoning: 'paywall text', rejectedAt: '2026-02-01T00:00:00Z',
    textFetchedAt: '2026-03-01T00:00:00Z',
    ...over,
  };
}

function staleNonReview(over = {}) {
  return {
    showId: 'y-2017', outletId: 'wsj', fullText: BODY, contentTier: 'complete',
    nonReviewFlag: true, nonReviewType: 'garbage_scrape', nonReviewEvidence: 'nav',
    nonReviewMethod: 'heuristic+llm', nonReviewFlaggedAt: '2026-07-01T00:00:00Z',
    textFetchedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

test('matches each automated text-quality reason when the verdict predates the fetch', () => {
  for (const reason of ['not_a_review', 'garbage_text', 'truncated_text']) {
    assert.deepEqual(staleAutomatedTextVerdicts(staleRejection({ rejectionReason: reason })), ['rejection'], reason);
  }
  assert.ok(isStaleAutomatedTextVerdict(staleRejection({ rejectedBy: 'news-article-heuristic-check' })));
  assert.ok(isStaleAutomatedTextVerdict(staleRejection({ rejectedBy: 'blocked-url-unscored-heuristic' })));
  assert.deepEqual(staleAutomatedTextVerdicts(staleNonReview()), ['nonReview']);
});

test('never matches wrong_production / wrong_show verdicts', () => {
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ rejectionReason: 'wrong_production' })), false);
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ rejectionReason: 'wrong_show' })), false);
  // torch-song-2018/wsj--terry-teachout.json shape: a stale nonReviewFlag under
  // a live wrong_production rejection must not be cleared (file stays excluded).
  assert.equal(isStaleAutomatedTextVerdict(staleNonReview({
    rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_production', rejectedAt: '2026-02-16T00:00:00Z',
  })), false);
});

test('never matches human verdicts', () => {
  for (const rb of ['manual-triage-bro-71', 'human-manual-cleanup', 'audit-unknown-outlets-triage', 'manual-contamination-triage']) {
    assert.equal(isStaleAutomatedTextVerdict(staleRejection({ rejectedBy: rb, rejectionReason: 'not_a_review' })), false, rb);
    assert.equal(isHumanRejecter(rb), true, rb);
  }
  assert.equal(isHumanRejecter('ensemble-scoreability-check'), false);
  const human = [
    { humanReviewScore: 70 }, { manualContentTier: 'complete' }, { _locked: true },
    { isNotReview: true }, { isNonReview: true }, { humanReviewedWrongProduction: true },
    { wrongProductionProvenance: 'manual' },
  ];
  for (const h of human) {
    assert.equal(isStaleAutomatedTextVerdict(staleRejection(h)), false, JSON.stringify(h));
    assert.equal(isStaleAutomatedTextVerdict(staleNonReview(h)), false, JSON.stringify(h));
  }
  // nonReviewFlag from any other method (manual / plain heuristic) is not ours.
  assert.equal(isStaleAutomatedTextVerdict(staleNonReview({ nonReviewMethod: 'heuristic' })), false);
  assert.equal(isStaleAutomatedTextVerdict(staleNonReview({ nonReviewMethod: undefined })), false);
});

test('needs the verdict to predate a complete fetch', () => {
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ rejectedAt: '2026-04-01T00:00:00Z' })), false, 'fresh verdict');
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ rejectedAt: undefined })), false, 'no timestamp');
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ textFetchedAt: undefined })), false, 'never fetched');
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ fullText: BODY.slice(0, 1400) })), false, 'short text');
  assert.equal(isStaleAutomatedTextVerdict(staleRejection({ contentTier: 'invalid' })), false, 'invalid tier');
  assert.equal(isStaleAutomatedTextVerdict(staleNonReview({ nonReviewFlaggedAt: '2026-09-01T00:00:00Z' })), false);
});

test('neutralize null-assigns (never deletes), keeps a breadcrumb, and unblocks inclusion', () => {
  const d = staleRejection();
  assert.equal(explainExclusion(d), 'rejectionReason');
  const kinds = neutralizeStaleAutomatedTextVerdict(d, '2026-09-29T00:00:00Z');
  assert.deepEqual(kinds, ['rejection']);
  for (const f of ['rejectionReason', 'rejectedAt', 'rejectedBy', 'rejectionReasoning']) {
    assert.ok(Object.prototype.hasOwnProperty.call(d, f), `${f} kept as a key`);
    assert.equal(d[f], null, f);
  }
  assert.equal(d.priorAutomatedTextVerdicts.length, 1);
  assert.equal(d.priorAutomatedTextVerdicts[0].rejectionReason, 'garbage_text');
  assert.equal(d.priorAutomatedTextVerdicts[0].clearedAt, '2026-09-29T00:00:00Z');
  assert.equal(isIncludableForRebuild(d), true);
  // Idempotent: nothing left to clear, breadcrumb not duplicated.
  assert.deepEqual(neutralizeStaleAutomatedTextVerdict(d), []);
  assert.equal(d.priorAutomatedTextVerdicts.length, 1);

  const n = staleNonReview();
  assert.equal(isIncludableForRebuild(n), false);
  neutralizeStaleAutomatedTextVerdict(n, '2026-09-29T00:00:00Z');
  assert.equal(n.nonReviewFlag, null);
  assert.equal(n.nonReviewMethod, null);
  assert.equal(n.priorAutomatedTextVerdicts[0].nonReviewType, 'garbage_scrape');
  assert.equal(isIncludableForRebuild(n), true);
});

test('a re-rejection after the clear stops the predicate matching (no loop)', () => {
  const d = staleRejection();
  neutralizeStaleAutomatedTextVerdict(d);
  Object.assign(d, { rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'not_a_review', rejectedAt: '2026-09-30T00:00:00Z' });
  assert.equal(isStaleAutomatedTextVerdict(d), false);
});

test('rejectedAtHumanCleared: wrongShow clears defer an orphaned rejectedAt only', () => {
  // stranger-things-the-first-shadow-west-end-2023/timeout-london--andrzej-lukowski.json
  const orphan = { fullText: BODY, contentTier: 'complete', rejectedAt: '2026-06-22T02:09:59Z', wrongShowOverride: true };
  assert.equal(rejectedAtHumanCleared(orphan), true);
  assert.notEqual(explainExclusion(orphan), 'rejectedAt');
  // Backstop kept: no clear → still excluded.
  assert.equal(explainExclusion({ fullText: BODY, contentTier: 'complete', rejectedAt: '2026-06-22T02:09:59Z' }), 'rejectedAt');
  // A wrongShow clear says nothing about a recorded non-wrong-show reason.
  assert.equal(rejectedAtHumanCleared({ ...orphan, rejectionReason: 'not_a_review' }), false);
  assert.equal(rejectedAtHumanCleared({ ...orphan, rejectionReason: 'wrong_show' }), true);
  assert.equal(rejectedAtHumanCleared({ rejectedAt: 'x', wrongShowManualClear: true }), true);
  // Pre-existing wrongProduction human clears still defer.
  assert.equal(rejectedAtHumanCleared({ rejectedAt: 'x', wrongProductionManualClear: true }), true);
  assert.equal(rejectedAtHumanCleared({ rejectedAt: 'x', humanReviewedWrongProduction: false }), true);
  assert.equal(rejectedAtHumanCleared({ rejectedAt: 'x' }), false);
});

// ---- ship-check round 2 ----
const {
  clearAutomatedTextRejectionOnRefetch,
  parkTextDerivedScore,
} = require('./stale-automated-text-verdict.js');
const { isTimestampAfter } = require('./review-guards.js');
const { isActionableRescore, isActionableUnscored } = require('./scoring-queue-counts.js');
const { getBestScore } = require('./rebuild-helpers.js');
const { isTransferableField } = require('./merge-review-fields.js');

const LLM_SCORE = { score: 42, confidence: 'high', bucket: 'Mixed' };

test('P1-1: neutralize parks the old-text score so nothing publishes before rescore', () => {
  // a-time-to-kill-2013/nytimes--charles-isherwood.json: assignedScore 42 on garbage_text
  const d = staleRejection({ assignedScore: 42, llmScore: LLM_SCORE, ensembleData: { x: 1 }, scoreSource: 'llm-v6' });
  neutralizeStaleAutomatedTextVerdict(d, '2026-09-29T00:00:00Z');
  for (const f of ['llmScore', 'ensembleData', 'assignedScore', 'scoreSource']) assert.equal(d[f], null, f);
  const parked = d.priorAutomatedTextVerdicts[0].parkedScore;
  assert.equal(parked.assignedScore, 42);
  assert.deepEqual(parked.llmScore, LLM_SCORE);
  assert.equal(d.staleTextVerdictScoreParked, true);
  assert.equal(getBestScore(d)?.score ?? null, null, 'no score → rebuild cannot publish it');
});

test('P1-1: an outlet explicit rating survives as assignedScore', () => {
  const d = staleRejection({ assignedScore: 70, llmScore: LLM_SCORE, originalScore: '4/5', originalScoreNormalized: 80 });
  neutralizeStaleAutomatedTextVerdict(d, '2026-09-29T00:00:00Z');
  assert.equal(d.llmScore, null);
  assert.equal(d.assignedScore, 80);
  assert.equal(d.scoreSource, 'explicit-after-stale-verdict-clear');
  // Non-text scoreSource (guardian-api): assignedScore untouched, only LLM fields parked.
  const g = { assignedScore: 60, scoreSource: 'guardian-api', llmScore: LLM_SCORE };
  assert.deepEqual(Object.keys(parkTextDerivedScore(g, 'x')), ['llmScore']);
  assert.equal(g.assignedScore, 60);
  assert.equal(parkTextDerivedScore({ scoreSource: 'guardian-api' }, 'x'), null, 'nothing to park → no stamp');
});

test('P1-1: the scorer picks up a parked file (no score + needsRescore)', () => {
  const d = staleRejection({ assignedScore: 42, llmScore: LLM_SCORE, scoreSource: 'llm-v6' });
  neutralizeStaleAutomatedTextVerdict(d, '2026-09-29T00:00:00Z');
  require('./rescore-flagging.js').markRescoreNeeded(d, 'x');
  const ctx = { showTitle: 'X' };
  assert.equal(isActionableRescore(d, ctx), true, '--needs-rescore selection');
  assert.equal(isActionableUnscored(d, ctx), true, 'unscored selection');
});

test('P1-1: safeWriteReview honors the parked null instead of restoring the old score', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { safeWriteReview } = require('./review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-park-'));
  const fp = path.join(dir, 'nytimes--charles-isherwood.json');
  const now = new Date().toISOString();
  const d = staleRejection({ assignedScore: 42, llmScore: LLM_SCORE, ensembleData: { x: 1 }, rejectedAt: '2026-02-01T00:00:00Z', textFetchedAt: now });
  fs.writeFileSync(fp, JSON.stringify(d));
  const next = JSON.parse(JSON.stringify(d));
  neutralizeStaleAutomatedTextVerdict(next, now);
  safeWriteReview(fp, next, { force: true });
  const back = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(back.llmScore, null);
  assert.equal(back.assignedScore, null);
  assert.equal(back.ensembleData, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P1-2: re-fetch clear only touches automated text-quality rejections', () => {
  const wp = staleRejection({ rejectionReason: 'wrong_production', llmScore: LLM_SCORE });
  assert.equal(clearAutomatedTextRejectionOnRefetch(wp), false);
  assert.equal(wp.rejectionReason, 'wrong_production');
  assert.deepEqual(wp.llmScore, LLM_SCORE);
  const ws = staleRejection({ rejectionReason: 'wrong_show' });
  assert.equal(clearAutomatedTextRejectionOnRefetch(ws), false);
  const noBy = staleRejection({ rejectedBy: undefined, rejectionReason: 'not_a_review' });
  assert.equal(clearAutomatedTextRejectionOnRefetch(noBy), false, 'rejectedBy undefined = hand-written');
  assert.equal(noBy.rejectionReason, 'not_a_review');
  const human = staleRejection({ rejectedBy: 'manual-triage-bro-71', rejectionReason: 'not_a_review' });
  assert.equal(clearAutomatedTextRejectionOnRefetch(human), false);

  const ok = staleRejection({ rejectionReason: 'not_a_review', assignedScore: 42, llmScore: LLM_SCORE, promptVersion: '5.4.0' });
  assert.equal(clearAutomatedTextRejectionOnRefetch(ok, '2026-09-29T00:00:00Z'), true);
  assert.equal(ok.rejectionReason, null);
  assert.equal(ok.rejectedBy, null);
  assert.equal(ok.promptVersion, null);
  assert.equal(ok.llmScore, null);
  assert.equal(ok.assignedScore, null);
  assert.equal(ok.needsRescore, true);
  const crumb = ok.priorAutomatedTextVerdicts[0];
  assert.equal(crumb.rejectionReason, 'not_a_review');
  assert.equal(crumb.parkedScore.assignedScore, 42);
});

test('P2-1: a nulled not_a_review (Hamlet shape) is not deferred by a wrongShow clear', () => {
  const hamlet = { rejectedAt: '2026-04-20T00:00:00Z', rejectionReason: null, rejectedBy: 'ensemble-scoreability-check',
    rejectionReasoning: 'claude: this is a film review, not a review of the play', wrongShowOverride: true };
  assert.equal(rejectedAtHumanCleared(hamlet), false);
  assert.equal(rejectedAtHumanCleared({ ...hamlet, rejectionReasoning: 'openai: wrong_show — different title' }), true);
  // fully stripped block (only the stamp left) = what the wrong-show clear scripts leave
  assert.equal(rejectedAtHumanCleared({ rejectedAt: 'x', wrongShowOverride: true }), true);
});

test('P2-3: isTimestampAfter parses both sides', () => {
  assert.equal(isTimestampAfter('2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z'), true);
  // string compare would say '2026-03-01' < '2026-03-01T00:00:00.001Z'; parse agrees and orders by instant
  assert.equal(isTimestampAfter('2026-03-01T05:00:00+05:00', '2026-02-28T23:30:00Z'), true);
  assert.equal(isTimestampAfter('2026-03-01T00:00:00Z', '2026-03-01T00:00:00.000Z'), false);
  assert.equal(isTimestampAfter(undefined, '2026-01-01'), false);
  assert.equal(isTimestampAfter('2026-01-01', 'garbage'), false);
});

test('P2-2: allow* flags never transfer between merged files', () => {
  for (const f of ['allowTourSignal', 'allowTourSignalReason', 'allowFilmSignal', 'allowFilmSignalReason', 'allowSignalHistory']) {
    assert.equal(isTransferableField(f), false, f);
  }
});

// BRO-4391: shape of the-car-man-west-end-2026/east-midlands-theatre--unknown.json
// (Curve Leicester review, ensemble wrong_production before tourLegs reached the prompt).
const {
  isPreContextWrongProduction,
  neutralizePreContextWrongProduction,
} = require('./stale-automated-text-verdict.js');
const { scanAutoclearVsEnsembleViolations, classifyAutoclearVsEnsemble } = require('./autoclear-vs-ensemble-scan.js');
const { PROTECTED_FIELDS } = require('./review-write-guard.js');

const CAR_MAN_SHOW = { id: 'the-car-man-west-end-2026', tourLegs: [{ venue: 'Curve', startDate: '2026-06-15', endDate: '2026-06-27' }] };
function carManRecord(over = {}) {
  return {
    showId: 'the-car-man-west-end-2026', outletId: 'east-midlands-theatre', criticName: 'Unknown',
    url: 'https://eastmidlandstheatre.com/2026/06/17/review-the-car-man-curve-leicester/',
    fullText: BODY, textFetchedAt: '2026-08-03T00:49:14.207Z', publishDate: '2026-06-17',
    contentTier: 'invalid', incompleteReason: 'wrong_content', wrongProduction: true,
    rejectedAt: '2026-08-03T01:04:49.113Z', rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'wrong_production', rejectionAgreeCount: 2, promptVersion: '5.4.0',
    wrongProductionAutoCleared: 'rebuild: UK URL on London show', wrongProductionRestoredNote: '[restored]',
    ...over,
  };
}

test('BRO-4391: Car Man Curve review is requeued once, never again after the stamp', () => {
  const d = carManRecord();
  assert.equal(isPreContextWrongProduction(d, CAR_MAN_SHOW), true);
  assert.equal(neutralizePreContextWrongProduction(d, CAR_MAN_SHOW, '2026-09-29T20:00:00.000Z'), true);
  assert.equal(d.rejectionReason, null);
  assert.equal(d.wrongProduction, undefined);
  assert.equal(d.productionVerdictRecheckedAt, '2026-09-29T20:00:00.000Z');
  assert.equal(d.priorAutomatedTextVerdicts.at(-1).clearedBy, 'pre-context-wrong-production-recheck');
  assert.equal(isIncludableForRebuild(d, CAR_MAN_SHOW), true);
  // stamp set => no second requeue, even if the scorer re-rejects with context
  assert.equal(isPreContextWrongProduction(d, CAR_MAN_SHOW), false);
  const reRejected = { ...d, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', wrongProduction: true, rejectedAt: '2026-09-30T00:00:00Z' };
  assert.equal(isPreContextWrongProduction(reRejected, CAR_MAN_SHOW), false);
  assert.equal(neutralizePreContextWrongProduction(reRejected, CAR_MAN_SHOW), false);
});

test('BRO-4391: needs a declared window, an automated ensemble verdict, no human verdict', () => {
  assert.equal(isPreContextWrongProduction(carManRecord({ publishDate: '2026-03-01' }), CAR_MAN_SHOW), false);
  assert.equal(isPreContextWrongProduction(carManRecord(), { id: 'x' }), false);
  assert.equal(isPreContextWrongProduction(carManRecord({ rejectedBy: 'manual-triage' }), CAR_MAN_SHOW), false);
  assert.equal(isPreContextWrongProduction(carManRecord({ humanReviewedWrongProduction: true }), CAR_MAN_SHOW), false);
  assert.equal(isPreContextWrongProduction(carManRecord({ fullText: 'short' }), CAR_MAN_SHOW), false);
  const priorRunShow = { priorRuns: [{ openingDate: '2025-01-01', closingDate: '2025-03-01' }] };
  assert.equal(isPreContextWrongProduction(carManRecord({ publishDate: '2025-02-01' }), priorRunShow), true);
});

test('BRO-4391: audit-autoclear-vs-ensemble does not restore from the pre-context verdict', () => {
  // The audit only reasons about files whose flag was auto-cleared while an ensemble verdict stood.
  const d = carManRecord({ wrongProduction: false });
  assert.equal(classifyAutoclearVsEnsemble(d, { reason: 'wrong_production', autoClearedField: 'wrongProductionAutoCleared', flagField: 'wrongProduction' }).isViolation, true);
  const rechecked = { ...d, productionVerdictRecheckedAt: '2026-09-29T20:00:00Z' };
  const r = classifyAutoclearVsEnsemble(rechecked, { reason: 'wrong_production', autoClearedField: 'wrongProductionAutoCleared', flagField: 'wrongProduction' });
  assert.equal(r.isViolation, false);
  // a rejection issued AFTER the recheck (with context) is still deferred to
  const post = { ...rechecked, rejectedAt: '2026-10-01T00:00:00Z' };
  assert.equal(classifyAutoclearVsEnsemble(post, { reason: 'wrong_production', autoClearedField: 'wrongProductionAutoCleared', flagField: 'wrongProduction' }).isViolation, true);
});

test('BRO-4391: the recheck stamp survives safeWriteReview (PROTECTED_FIELDS)', () => {
  assert.ok(PROTECTED_FIELDS.includes('productionVerdictRecheckedAt'));
});
