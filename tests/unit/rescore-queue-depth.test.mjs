// Task #597 second-opinion review finding: a naive "needsRescore===true
// total" counter never reaches zero, because files stamped
// isBlockedFromRescore() (task #655's terminal text-gate stamp) are
// LEGITIMATELY left needsRescore=true forever by design. This test proves
// computeRescoreQueueDepth's "unblocked" count excludes them — the guard
// against progress-watch.js becoming permanently-stalled noise on the very
// queue that motivated it.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeRescoreQueueDepth } = require('../../scripts/lib/rescore-queue-depth.js');

let tmpDir;
let showDir;

function seedFile(name, data) {
  fs.writeFileSync(path.join(showDir, name), JSON.stringify(data, null, 2) + '\n');
}

const baseScoreable = (over = {}) => ({
  needsRescore: true,
  rescoreReason: 'bw-v6-decompression',
  fullText: 'x'.repeat(2000),
  contentTier: 'complete',
  textStatus: 'complete',
  isFullReview: true,
  outletId: 'timeout',
  criticName: 'Jane Critic',
  llmScore: { score: 70 },
  ...over,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-queue-depth-'));
  showDir = path.join(tmpDir, 'demo-show-2026');
  fs.mkdirSync(showDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const titleById = new Map([['demo-show-2026', 'Demo Show']]);

describe('computeRescoreQueueDepth', () => {
  test('an unflagged review is not counted at all', () => {
    seedFile('outlet--critic.json', baseScoreable({ needsRescore: undefined }));
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 0);
    assert.equal(r.unblocked, 0);
  });

  test('a flagged, scoreable, non-blocked review counts as unblocked', () => {
    seedFile('outlet--critic.json', baseScoreable());
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 1);
    assert.equal(r.unblocked, 1);
    assert.equal(r.blocked, 0);
    assert.equal(r.byReasonUnblocked['bw-v6-decompression'], 1);
  });

  test('a flagged review the scorer would reject (isScoreable=false) is excluded from unblocked, not counted as blocked', () => {
    seedFile('outlet--critic.json', baseScoreable({ isNonReview: true }));
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 1);
    assert.equal(r.notScoreable, 1);
    assert.equal(r.unblocked, 0);
    assert.equal(r.blocked, 0);
  });

  // THE finding: task #655's terminal text-gate stamp legitimately holds
  // needsRescore=true forever until fullText itself changes. It must NOT
  // count as "remaining work" for the stall monitor.
  test('a flagged review stamped isBlockedFromRescore (task #655) is excluded from unblocked', () => {
    const fullText = 'short text';
    seedFile('outlet--critic.json', baseScoreable({
      fullText,
      rescoreBlockedReason: 'input_validation_failed:body_too_short',
      rescoreBlockedAt: '2026-07-29T00:00:00.000Z',
      rescoreBlockedTextLength: fullText.length,
    }));
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 1);
    assert.equal(r.notScoreable, 0);
    assert.equal(r.blocked, 1);
    assert.equal(r.unblocked, 0);
    assert.deepEqual(r.byReasonUnblocked, {});
  });

  test('a previously-blocked review becomes unblocked again once fullText actually changed (recovery)', () => {
    seedFile('outlet--critic.json', baseScoreable({
      fullText: 'x'.repeat(2000), // grew since the block was stamped
      rescoreBlockedReason: 'input_validation_failed:body_too_short',
      rescoreBlockedAt: '2026-07-29T00:00:00.000Z',
      rescoreBlockedTextLength: 10, // stale fingerprint from the short version
    }));
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.blocked, 0);
    assert.equal(r.unblocked, 1);
  });

  test('mixed queue: totals partition cleanly across all three classes', () => {
    seedFile('a.json', baseScoreable()); // unblocked
    seedFile('b.json', baseScoreable({ isNonReview: true })); // not scoreable
    const fullText = 'short';
    seedFile('c.json', baseScoreable({
      fullText,
      rescoreBlockedReason: 'input_validation_failed:body_too_short',
      rescoreBlockedTextLength: fullText.length,
    })); // blocked
    seedFile('d.json', baseScoreable({ needsRescore: undefined })); // not flagged at all

    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 3);
    assert.equal(r.notScoreable, 1);
    assert.equal(r.blocked, 1);
    assert.equal(r.unblocked, 1);
  });
});
