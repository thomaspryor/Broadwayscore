/**
 * Guards the rescore-queue retirement contract (2026-07-26 incident).
 *
 * The bug: scripts/llm-scoring/index.ts had two success paths that persist a
 * score, and only one cleared `needsRescore`. Files scored via the Haiku
 * fallback stayed queued and were re-scored by every subsequent drain — a
 * queue that could never reach zero and unbounded 3-model API spend.
 *
 * Test 1-3 cover the pure helper. Test 4 is the one that actually prevents
 * recurrence: it reads index.ts and asserts every scoring success path that
 * calls saveReviewFile() is preceded by markRescoreComplete(). A new success
 * path added without the call fails here.
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

const { markRescoreComplete, stampTerminalScoringFailure, isBlockedFromRescore } = require(path.join(REPO, 'scripts/lib/rescore-lifecycle.js'));
// Detector lives with its sibling in the canonical stuck-flag lib, not here.
const { isScoredButStillQueued } = require(path.join(REPO, 'scripts/lib/stuck-rescore-flag.js'));

test('markRescoreComplete clears the flag and stamps completion', () => {
  const f = { needsRescore: true, rescoreReason: 'bw-v6-decompression', assignedScore: 91 };
  markRescoreComplete(f, '2026-07-26T21:00:00.000Z');
  assert.equal(f.needsRescore, undefined, 'needsRescore must be gone');
  assert.equal(f.rescoreCompletedAt, '2026-07-26T21:00:00.000Z');
  assert.equal(
    f.rescoreReason,
    'bw-v6-decompression',
    'rescoreReason is history — audits group by it and must keep it'
  );
});

test('markRescoreComplete handles the snake_case spelling in older sweeps', () => {
  const f = { needs_rescore: true, assignedScore: 80 };
  markRescoreComplete(f, '2026-07-26T21:00:00.000Z');
  assert.equal(f.needs_rescore, undefined);
  assert.equal(f.rescoreCompletedAt, '2026-07-26T21:00:00.000Z');
});

test('markRescoreComplete is a no-op on a file that was never queued', () => {
  const f = { assignedScore: 75 };
  markRescoreComplete(f, '2026-07-26T21:00:00.000Z');
  assert.equal(f.rescoreCompletedAt, undefined, 'no stamp when nothing was retired');
});

test('isScoredButStillQueued fires only on the fallback fingerprint', () => {
  // The shape of the files genuinely stuck on 2026-07-26: scored by the
  // Haiku-fallback path (the only writer of this scoreSource) and still queued.
  assert.equal(
    isScoredButStillQueued({
      needsRescore: true,
      rescoreReason: 'bw-v6-decompression',
      scoreSource: 'manual-cleared-haiku-fallback',
      llmMetadata: { scoredAt: '2026-07-26T20:13:59.984Z' },
    }),
    true
  );
  // REGRESSION GUARD (the P1 caught in adversarial review): a legitimate requeue
  // of an already-scored review must NOT be called stuck. 162 corpus files look
  // like this, and the auditor's --fix deletes needsRescore — flagging them
  // would cancel real pending rescores.
  assert.equal(
    isScoredButStillQueued({
      needsRescore: true,
      rescoreReason: 'fullText added after excerpt-based scoring',
      scoreSource: 'llm-v6',
      llmMetadata: { scoredAt: '2026-06-01T00:00:00.000Z' },
    }),
    false
  );
  // Queued and genuinely never scored — pending, not stuck.
  assert.equal(
    isScoredButStillQueued({ needsRescore: true, rescoreReason: 'bw-v6-decompression' }),
    false
  );
  // Already retired by a post-fix run.
  assert.equal(
    isScoredButStillQueued({
      needsRescore: true,
      scoreSource: 'manual-cleared-haiku-fallback',
      llmMetadata: { scoredAt: '2026-07-26T20:13:59.984Z' },
      rescoreCompletedAt: '2026-07-26T21:00:00.000Z',
    }),
    false
  );
});

test('stampTerminalScoringFailure records reason, attempt count, and text fingerprint', () => {
  const f = { needsRescore: true, rescoreReason: 'bw-v6-decompression', fullText: 'x'.repeat(165) };
  stampTerminalScoringFailure(f, 'input_validation_failed:body_too_short', '2026-07-30T05:25:00.000Z');
  assert.equal(f.rescoreAttempts, 1);
  assert.equal(f.rescoreBlockedReason, 'input_validation_failed:body_too_short');
  assert.equal(f.rescoreBlockedAt, '2026-07-30T05:25:00.000Z');
  assert.equal(f.rescoreBlockedTextLength, 165);
  // needsRescore is untouched — this is queued-but-unscoreable work, not done.
  assert.equal(f.needsRescore, true);

  // A second failure on the same (unchanged) text increments the counter.
  stampTerminalScoringFailure(f, 'input_validation_failed:body_too_short', '2026-07-31T05:25:00.000Z');
  assert.equal(f.rescoreAttempts, 2);
});

test('isBlockedFromRescore skips only when fullText is unchanged since the block', () => {
  // No block stamp at all — never attempted, not blocked.
  assert.equal(isBlockedFromRescore({ needsRescore: true, fullText: 'short' }), false);

  // Blocked, and fullText is still the same length that failed — skip it.
  const blocked = { fullText: 'x'.repeat(165), rescoreBlockedReason: 'input_validation_failed:body_too_short', rescoreBlockedTextLength: 165 };
  assert.equal(isBlockedFromRescore(blocked), true);

  // fullText grew (e.g. a recovery pipeline re-scraped it) — eligible again,
  // no producer needed to remember to clear the stamp.
  const recovered = { fullText: 'x'.repeat(1200), rescoreBlockedReason: 'input_validation_failed:body_too_short', rescoreBlockedTextLength: 165 };
  assert.equal(isBlockedFromRescore(recovered), false);
});

test('every scoring success path in index.ts retires the rescore queue', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/llm-scoring/index.ts'), 'utf8');
  const lines = src.split('\n');

  // Success-path saves persist a *scored* object. The rejection/failure paths
  // save `fileData` (the untouched input) and must NOT retire the queue —
  // those files still need a rescore.
  const successSaves = [];
  lines.forEach((line, i) => {
    if (!/saveReviewFile\(/.test(line)) return;
    if (/saveReviewFile\(filePath,\s*(scoredAny|result\.scoredFile)\s*\)/.test(line)) {
      successSaves.push(i);
    }
  });

  assert.ok(
    successSaves.length >= 2,
    `expected at least 2 scoring success paths, found ${successSaves.length} — ` +
      'if a path was renamed, update this test rather than deleting it'
  );

  // Anchor on the enclosing success block rather than a fixed line window: the
  // main path legitimately has ~30 lines of unrelated lifecycle handling
  // (singleModelEmergency, garbage detection) between the retirement call and
  // the save, and a fixed window produced a false positive on it.
  const SUCCESS_BLOCK = /\b(result|fbResult)\.success\s*&&\s*\1\.scoredFile\b/;
  for (const idx of successSaves) {
    let blockStart = -1;
    for (let i = idx; i >= 0; i--) {
      if (SUCCESS_BLOCK.test(lines[i])) { blockStart = i; break; }
    }
    assert.ok(
      blockStart !== -1,
      `saveReviewFile of a scored object at index.ts:${idx + 1} is not inside a ` +
        'recognized success block — update SUCCESS_BLOCK if the guard was reworded'
    );
    const block = lines.slice(blockStart, idx + 1).join('\n');
    assert.ok(
      /markRescoreComplete\(/.test(block),
      `scoring success path at index.ts:${idx + 1} persists a score without ` +
        'markRescoreComplete() — the file will be re-scored on every drain forever. ' +
        'See scripts/lib/rescore-lifecycle.js.'
    );
  }
});
