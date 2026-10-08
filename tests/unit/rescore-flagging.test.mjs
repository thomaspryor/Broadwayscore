/**
 * Guards the write-time / flag-clear side of the rescore lifecycle (card
 * #1902): a review that gains fullText after being scored on an excerpt, or
 * whose wrongProduction flag clears as a false positive on an already-scored
 * file, must be re-queued for scoring — but ONLY when doing so is safe.
 *
 * isStaleScoreInput() is the single gate shared by review-file-writer.js's
 * write-time hook and rebuild-all-reviews.js's wrongProduction auto-clear
 * sites. Getting it wrong in either direction reproduces a real incident:
 * too loose and it creates permanent stuck flags (needsRescore=true on a
 * file isScoreable() rejects — the 2026-06-30 late-star bug, guarded by
 * stuck-rescore-flag.js); too tight and scores go stale silently forever
 * (this card's own trigger — 653 reviews measured with contentTier
 * complete/truncated but scored off an excerpt).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const { isStaleScoreInput, markRescoreNeeded, isFalseTruncationScore, isTruncatedScoreNowComplete } = require(path.join(REPO, 'scripts/lib/rescore-flagging.js'));

test('fullText added to a previously excerpt-scored, isScoreable file → flag set + stamped', () => {
  const data = {
    assignedScore: 72,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
  };
  assert.equal(isStaleScoreInput(data), true, 'isScoreable-eligible excerpt-scored file must read as stale');
  markRescoreNeeded(data, 'fullText added after excerpt-based score', '2026-08-26T00:00:00.000Z');
  assert.equal(data.needsRescore, true);
  assert.equal(data.rescoreReason, 'fullText added after excerpt-based score');
  assert.equal(data.rescoreFlaggedAt, '2026-08-26T00:00:00.000Z');
});

test('fullText added to a never-scored file → NO flag', () => {
  // No assignedScore at all — this is the unscored pipeline's job, not a
  // rescore. Flagging it would reproduce the "about to be scored for the
  // first time" bug the write-time hook must avoid.
  const data = {
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
  };
  assert.equal(isStaleScoreInput(data), false);
});

test('fullText added to a non-isScoreable file → NO flag (the 278-file stuck-flag guard)', () => {
  // Scored once, then flagged wrongProduction — isScoreable() now rejects it.
  // Flagging needsRescore here would create a permanent stuck flag: the
  // consumer filters to isScoreable() before processing and never clears it.
  const data = {
    assignedScore: 55,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    wrongProduction: true,
  };
  assert.equal(isStaleScoreInput(data), false);
});

test('already-flagged file → idempotent, no duplicate stamp', () => {
  const data = {
    assignedScore: 72,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    needsRescore: true,
    rescoreReason: 'bw-v6-decompression',
    rescoreFlaggedAt: '2026-08-01T00:00:00.000Z',
  };
  assert.equal(isStaleScoreInput(data), false, 'already-queued file is not "newly" stale');
  markRescoreNeeded(data, 'fullText added after excerpt-based score', '2026-08-26T00:00:00.000Z');
  assert.equal(data.rescoreReason, 'bw-v6-decompression', 'markRescoreNeeded must not overwrite an existing flag');
  assert.equal(data.rescoreFlaggedAt, '2026-08-01T00:00:00.000Z');
});

test('isStaleScoreInput ignores files already scored off fullText', () => {
  const data = {
    assignedScore: 80,
    llmMetadata: { textSource: { type: 'fullText' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
  };
  assert.equal(isStaleScoreInput(data), false);
});

test('isStaleScoreInput flags ensemble-scored files too (668/696 of the real backlog)', () => {
  // Measured against the corpus (card #1902 baseline, 2026-08-26): ensemble
  // scoring selects the best text AVAILABLE AT SCORE TIME, not the best text
  // ever — fullText arriving afterward goes stale exactly like the
  // single-model case. Excluding ensembleData here would have suppressed
  // 668 of the 696 real candidates.
  const data = {
    assignedScore: 80,
    llmMetadata: { textSource: { type: 'excerpt' } },
    ensembleData: { models: 3 },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
  };
  assert.equal(isStaleScoreInput(data), true);
});

test('markRescoreNeeded is a no-op on non-object input', () => {
  assert.equal(markRescoreNeeded(null, 'x'), null);
  assert.equal(markRescoreNeeded(undefined, 'x'), undefined);
});

// Card #1905 (cousin of #1902): the CV self-heal wrongProduction/wrongShow
// clear sites in rebuild-all-reviews.js share the same shape as the
// dateless-revival/priorRuns sites above — clearing an exclusion flag on a
// file that may already carry a stale, excerpt-based score.

test('CV self-heal clears wrongProduction on an already-scored excerpt file → stale', () => {
  const data = {
    assignedScore: 68,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    wrongProduction: false, // already cleared by the self-heal before this check runs
  };
  assert.equal(isStaleScoreInput(data), true, 'a self-healed, isScoreable excerpt-scored file must read as stale');
  markRescoreNeeded(data, 'wrongProduction CV self-heal cleared a stale promotion');
  assert.equal(data.needsRescore, true);
  assert.equal(data.rescoreReason, 'wrongProduction CV self-heal cleared a stale promotion');
});

test('CV self-heal clears wrongShow on an already-scored excerpt file → stale', () => {
  const data = {
    assignedScore: 74,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    wrongShow: false, // already cleared by the self-heal before this check runs
  };
  assert.equal(isStaleScoreInput(data), true, 'a self-healed, isScoreable excerpt-scored file must read as stale');
  markRescoreNeeded(data, 'wrongShow CV self-heal cleared a stale promotion');
  assert.equal(data.needsRescore, true);
  assert.equal(data.rescoreReason, 'wrongShow CV self-heal cleared a stale promotion');
});

test('CV self-heal clear on a still non-includable file (other flag still set) → NO flag', () => {
  // The self-heal cleared wrongProduction, but wrongShow is still true —
  // isScoreable() rejects it, so flagging needsRescore would create a
  // permanent stuck flag (the same 278-file guard as above).
  const data = {
    assignedScore: 60,
    llmMetadata: { textSource: { type: 'excerpt' } },
    contentTier: 'complete',
    fullText: 'x'.repeat(2000),
    wrongProduction: false,
    wrongShow: true,
  };
  assert.equal(isStaleScoreInput(data), false);
});

// School Girls 2026-09-29 review: guards added when the stale sweep was wired
// into the scoring workflows.
const staleBase = () => ({
  assignedScore: 81,
  scoreSource: 'llm-v6',
  llmMetadata: { textSource: { type: 'excerpt' } },
  contentTier: 'complete',
  fullText: 'x'.repeat(2000),
  textFetchedAt: '2026-09-29T03:36:49.467Z',
});

test('excerpt-scored LLM review whose fullText arrived later reads as stale (Guardian, School Girls)', () => {
  assert.equal(isStaleScoreInput(staleBase()), true);
});

test('loop guard: already rescored with the current text on disk → not stale again', () => {
  const d = { ...staleBase(), rescoreCompletedAt: '2026-09-29T06:00:00.000Z' };
  assert.equal(isStaleScoreInput(d), false);
});

test('loop guard releases when newer text arrives after the last rescore', () => {
  const d = { ...staleBase(), rescoreCompletedAt: '2026-09-29T02:00:00.000Z' };
  assert.equal(isStaleScoreInput(d), true);
});

test('human or extracted star scores are never flagged for an LLM rescore', () => {
  assert.equal(isStaleScoreInput({ ...staleBase(), humanReviewScore: 80 }), false);
  assert.equal(isStaleScoreInput({ ...staleBase(), scoreSource: 'manual_extracted_star_rating' }), false);
  assert.equal(isStaleScoreInput({ ...staleBase(), scoreSource: 'explicit-rating' }), false);
  assert.equal(isStaleScoreInput({ ...staleBase(), scoreSource: 'anchored-v6' }), true);
  assert.equal(isStaleScoreInput({ ...staleBase(), scoreSource: undefined }), true);
});

// BRO-4486: NYT Degenerates was scored on a paywall-cut copy stored as
// fullText (textSource status 'truncated'); the complete text landed two hours
// later and nothing re-flagged it.
const COMPLETE_BODY = 'The production is vivid and the cast is strong throughout the evening. '.repeat(40);
function truncatedFullTextScore(overrides = {}) {
  return {
    assignedScore: 74,
    contentTier: 'complete',
    fullText: COMPLETE_BODY,
    textFetchedAt: '2026-09-30T18:33:54.689Z',
    llmMetadata: { scoredAt: '2026-09-30T16:46:32.881Z', textSource: { type: 'fullText', status: 'truncated' } },
    ...overrides,
  };
}

test('fullText scored as truncated, complete text fetched later → stale', () => {
  assert.equal(isStaleScoreInput(truncatedFullTextScore()), true);
});

test('fullText scored as truncated, text not refetched since scoring → NOT stale', () => {
  assert.equal(isStaleScoreInput(truncatedFullTextScore({ textFetchedAt: '2026-09-30T16:00:00.000Z' })), false);
});

test('fullText scored as truncated, newer text still truncated → NOT stale (no rescore loop)', () => {
  const data = truncatedFullTextScore({ fullText: COMPLETE_BODY.slice(0, 1500) + ' Subscribe to continue reading' });
  // (BRO-4804: a bare mid-sentence ending on a complete-tier file is now a footer, not truncation; paywall wording still is.)
  assert.equal(isStaleScoreInput(data), false);
});

test('fullText scored as complete → never stale, whatever was fetched later', () => {
  const data = truncatedFullTextScore();
  data.llmMetadata.textSource.status = 'complete';
  assert.equal(isStaleScoreInput(data), false);
});

// BRO-2407 prevention: every persisted wrongProduction / wrongShow auto-clear
// in rebuild-all-reviews.js must call markRescoreNeeded between the clear and
// the NEXT safeWriteReview, otherwise a cleared false positive on an
// already-scored file keeps a stale score until the daily audit sweep.
test('every persisted wrongProduction/wrongShow clear in rebuild-all-reviews.js calls markRescoreNeeded before its write', async () => {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(path.join(REPO, 'scripts/rebuild-all-reviews.js'), 'utf8').split('\n');
  const clearRe = /(\b\w+\.(wrongProduction|wrongShow) = false;|delete \w+\.(wrongProduction|wrongShow);)/;
  const missing = [];
  let checked = 0;
  lines.forEach((l, i) => {
    if (!clearRe.test(l)) return;
    let w = -1;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      if (/safeWriteReview\(/.test(lines[j])) { w = j; break; }
    }
    if (w < 0) return; // in-memory only (nuclear guard etc.), nothing persisted
    checked++;
    if (!lines.slice(i, w).some(x => /markRescoreNeeded\(/.test(x))) missing.push(i + 1);
  });
  assert.ok(checked >= 10, `expected >=10 persisted clear sites, saw ${checked} (regex drift?)`);
  assert.deepEqual(missing, [], `clear without markRescoreNeeded before write at lines ${missing.join(', ')}`);
});

// BRO-4804: a page footer made the scorer call complete reviews truncated.
const BODY_4804 = 'Slam Frank is a bucking bronco in a world of pony rides. '.repeat(30)
  + 'But if you can hang on till the end, you might find that getting knocked around can jostle new things loose.';
const footerScored = (over = {}) => ({
  assignedScore: 67,
  contentTier: 'complete',
  fullText: BODY_4804 + ' Add as a preferred source on Google',
  llmMetadata: { textSource: { type: 'fullText', status: 'truncated' } },
  ...over,
});

test('BRO-4804: footer-only truncation on a complete-tier scored file is a false-truncation score', () => {
  assert.equal(isFalseTruncationScore(footerScored()), true);
});

test('BRO-4804: not flagged when the scorer saw it as complete, the tier is not complete, or it is already queued', () => {
  assert.equal(isFalseTruncationScore(footerScored({ llmMetadata: { textSource: { type: 'fullText', status: 'complete' } } })), false);
  assert.equal(isFalseTruncationScore(footerScored({ contentTier: 'truncated' })), false);
  assert.equal(isFalseTruncationScore(footerScored({ needsRescore: true })), false);
  assert.equal(isFalseTruncationScore(footerScored({ humanReviewScore: 70 })), false);
  assert.equal(isFalseTruncationScore(footerScored({ scoreSource: 'explicit-rating' })), false);
  // _locked files get every protected field restored at push, so a rescore never sticks
  assert.equal(isFalseTruncationScore(footerScored({ _locked: true })), false);
});

test('BRO-4804: a genuinely truncated text (paywall wording) is never flagged', () => {
  assert.equal(isFalseTruncationScore(footerScored({ fullText: BODY_4804 + ' Subscribe to continue reading' })), false);
});

test('BRO-4804: isTruncatedScoreNowComplete reads a footer-ended complete file as complete', () => {
  const d = footerScored({
    llmMetadata: { scoredAt: '2026-10-01T00:00:00Z', textSource: { type: 'fullText', status: 'truncated' } },
    textFetchedAt: '2026-10-02T00:00:00Z',
  });
  assert.equal(isTruncatedScoreNowComplete(d), true);
});
