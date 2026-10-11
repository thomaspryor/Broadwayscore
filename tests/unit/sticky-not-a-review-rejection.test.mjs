/**
 * BRO-5047: the ensemble paid to re-reject the same ~17 not_a_review files
 * about 3 times an hour. index.ts set contentTier='invalid'; every rebuild
 * re-derived contentTier from the text and wrote 'complete' back, and for
 * reviews kept alive by an aggregator thumb that tier was the only thing
 * keeping them out of the unscored queue.
 *
 * Tests require the real functions (CLAUDE.md rule 15). The source checks at
 * the bottom fail if a rejection writer stops stamping the fingerprint, or the
 * batch submit stops checking for an in-flight batch.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const {
  rejectionTextFingerprint,
  stampRejectedTextFingerprint,
  isBlockedByStickyRejection,
} = require(path.join(REPO, 'scripts/lib/rescore-lifecycle.js'));
const { unscoredSkipReason, UNSCORED_SKIP } = require(path.join(REPO, 'scripts/lib/scoring-queue-counts.js'));
const { mayStartNewBatch } = require(path.join(REPO, 'scripts/lib/batch-drain-decision.js'));
const { readScoringPromptVersion, DECL_RE } = require(path.join(REPO, 'scripts/lib/scoring-prompt-version.js'));
const CURRENT_PROMPT = readScoringPromptVersion();

// Shape of the real file that looped (beetlejuice-tour-2022 Charleston Scene):
// a not_a_review rejection whose contentTier a rebuild has reset to 'complete',
// kept includable by a BWW thumb.
function rejected(over = {}) {
  const f = {
    showId: 'beetlejuice-tour-2022',
    outlet: 'Charleston Scene',
    fullText: 'A feature about the touring production and its puppets. '.repeat(30),
    bwwExcerpt: 'The ghost with the most is back, and the tour delivers every gag the fans came for.',
    bwwThumb: 'Up',
    contentTier: 'complete',
    rejectedAt: '2026-10-10T21:01:26.040Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'not_a_review',
    promptVersion: CURRENT_PROMPT,
  };
  stampRejectedTextFingerprint(f);
  return Object.assign(f, over);
}

test('fingerprint is stable and changes when any scorable text changes', () => {
  const a = rejected();
  assert.strictEqual(rejectionTextFingerprint(a), rejectionTextFingerprint({ ...a }));
  assert.notStrictEqual(rejectionTextFingerprint(a), rejectionTextFingerprint({ ...a, fullText: a.fullText + ' More.' }));
  assert.notStrictEqual(rejectionTextFingerprint(a), rejectionTextFingerprint({ ...a, dtliExcerpt: 'A new excerpt appeared.' }));
  assert.match(a.rejectedTextHash, /^[0-9a-f]{40}$/);
});

test('blocks a not_a_review rejection whose text is unchanged, even after a rebuild reset contentTier', () => {
  assert.strictEqual(isBlockedByStickyRejection(rejected()), true);
});

test('reads the scorer prompt version from config.ts, declared exactly once', () => {
  assert.match(CURRENT_PROMPT, /^\d+\.\d+\.\d+$/);
  const src = fs.readFileSync(path.join(REPO, 'scripts/llm-scoring/config.ts'), 'utf8');
  assert.strictEqual((src.match(new RegExp(DECL_RE.source, 'gm')) || []).length, 1);
});

test('lifts the block when the scoring prompt changed since the rejection', () => {
  assert.strictEqual(isBlockedByStickyRejection(rejected({ promptVersion: '0.0.1' })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ promptVersion: undefined })), false);
  // An explicit current version (what index.ts passes) is honoured.
  assert.strictEqual(isBlockedByStickyRejection(rejected({ promptVersion: '9.9.9' }), { promptVersion: '9.9.9' }), true);
});

test('re-evaluates when the text changed since the rejection', () => {
  assert.strictEqual(isBlockedByStickyRejection(rejected({ fullText: 'The real review arrived. '.repeat(40) })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ showScoreExcerpt: 'New aggregator excerpt.' })), false);
});

test('never blocks other rejection kinds, other writers, legacy rejections, flagged rescores or manual clears', () => {
  assert.strictEqual(isBlockedByStickyRejection(rejected({ rejectionReason: 'wrong_show' })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ rejectionReason: 'garbage_text' })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ rejectedBy: 'human' })), false);
  // The pre-opening interview check is free and date-dependent: never sticky.
  assert.strictEqual(isBlockedByStickyRejection(rejected({ rejectedBy: 'preopening-interview-signal' })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ rejectedTextHash: undefined })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ needsRescore: true })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ wrongShowManualClear: true })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ isCombinedReview: true })), false);
  assert.strictEqual(isBlockedByStickyRejection(rejected({ humanReviewedWrongProduction: false })), false);
  assert.strictEqual(isBlockedByStickyRejection(null), false);
});

test('the shared queue counter excludes it, so the cascade gate and the scorer agree', () => {
  assert.strictEqual(unscoredSkipReason(rejected(), {}), UNSCORED_SKIP.STICKY_REJECTION);
  // Already-scored still wins (it is not unscored at all).
  assert.strictEqual(unscoredSkipReason(rejected({ llmScore: { score: 70 } }), {}), UNSCORED_SKIP.ALREADY_SCORED);
  // Changed text falls through to the normal checks, never to the sticky reason.
  assert.notStrictEqual(
    unscoredSkipReason(rejected({ fullText: 'The real review arrived. '.repeat(40) }), {}),
    UNSCORED_SKIP.STICKY_REJECTION,
  );
});

test('mayStartNewBatch refuses while a paid batch is in flight', () => {
  assert.deepStrictEqual(mayStartNewBatch(null), { allowed: true, reason: null });
  const r = mayStartNewBatch({ submittedAt: '2026-10-11T05:02:00Z', itemCount: 400 });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /2026-10-11T05:02:00Z/);
});

test('index.ts stamps the fingerprint at every ensemble rejection write and gates the batch submit', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/llm-scoring/index.ts'), 'utf8');
  const writer = "rejectedBy = 'ensemble-scoreability-check'";
  let at = src.indexOf(writer);
  assert.ok(at > 0, 'ensemble rejection writer not found');
  for (; at >= 0; at = src.indexOf(writer, at + 1)) {
    const save = src.indexOf('saveReviewFile(', at);
    assert.ok(save > at, 'no save after an ensemble rejection write');
    assert.ok(src.slice(at, save).includes('stampRejectedTextFingerprint('), 'every ensemble rejection write must stamp rejectedTextHash before saving');
  }
  // The selector passes the scorer's own PROMPT_VERSION, not a re-read copy.
  assert.ok(src.includes('isBlockedByStickyRejection(f.data as any, { promptVersion: PROMPT_VERSION })'));
  const submit = src.indexOf('await submitBatches(');
  const gate = src.lastIndexOf('mayStartNewBatch(readBatchState())', submit);
  assert.ok(gate > 0 && submit - gate < 1200, 'batch submit must be gated by mayStartNewBatch(readBatchState())');
});
