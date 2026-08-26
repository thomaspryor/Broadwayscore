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

const { isStaleScoreInput, markRescoreNeeded } = require(path.join(REPO, 'scripts/lib/rescore-flagging.js'));

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
