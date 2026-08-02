// Task #751: a monitor wired to the RAW needsRescore===true count never
// falls once a queue accumulates permanently-blocked (isBlockedFromRescore,
// task #655) entries — stampTerminalScoringFailure intentionally leaves
// needsRescore=true on those files forever. Sibling test
// rescore-queue-depth.test.mjs proves the single-snapshot partition
// (blocked/notScoreable/unblocked) is correct; this test proves the
// TREND-DETECTION consequence end to end: feeding computeRescoreQueueDepth's
// `unblocked` count (not `totalFlagged`) into progress-watch.js's
// isStalled() tracks the queue draining even while the raw total stays flat
// — and that a naive raw-based wiring would have false-alarmed on the exact
// same underlying data.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeRescoreQueueDepth } = require('../../scripts/lib/rescore-queue-depth.js');
const { recordProgress, isStalled } = require('../../scripts/lib/progress-watch.js');

let tmpDir;
let showDir;

function seedFile(name, data) {
  fs.writeFileSync(path.join(showDir, name), JSON.stringify(data, null, 2) + '\n');
}

function resetShowDir() {
  fs.rmSync(showDir, { recursive: true, force: true });
  fs.mkdirSync(showDir, { recursive: true });
}

const blockedFile = (n) => ({
  needsRescore: true,
  rescoreReason: 'bw-v6-decompression',
  fullText: 'short',
  rescoreBlockedReason: 'input_validation_failed:body_too_short',
  rescoreBlockedAt: '2026-07-29T00:00:00.000Z',
  rescoreBlockedTextLength: 'short'.length,
  contentTier: 'stub',
  textStatus: 'stub',
  isFullReview: true,
  outletId: `blocked-outlet-${n}`,
  criticName: 'Blocked Critic',
});

const actionableFile = (n) => ({
  needsRescore: true,
  rescoreReason: 'bw-v6-decompression',
  fullText: 'x'.repeat(2000),
  contentTier: 'complete',
  textStatus: 'complete',
  isFullReview: true,
  outletId: `actionable-outlet-${n}`,
  criticName: 'Actionable Critic',
  llmScore: { score: 70 },
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-actionable-depth-'));
  showDir = path.join(tmpDir, 'bw-v6-decompression-2026');
  fs.mkdirSync(showDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const titleById = new Map([['bw-v6-decompression-2026', 'BW V6 Decompression']]);

describe('rescore actionable depth vs raw depth (task #751)', () => {
  test('actionable count excludes rescoreBlockedReason-stamped files, raw count does not', () => {
    seedFile('a.json', blockedFile(1));
    seedFile('b.json', blockedFile(2));
    seedFile('c.json', actionableFile(1));
    const r = computeRescoreQueueDepth(tmpDir, titleById);
    assert.equal(r.totalFlagged, 3);
    assert.equal(r.blocked, 2);
    assert.equal(r.unblocked, 1);
  });

  test('raw depth flat + actionable depth falling: naive raw-based watch alarms, actionable-based watch does not', () => {
    // Cycle 1: 2 permanently-blocked files + 3 actionable files (raw=5).
    resetShowDir();
    seedFile('blocked-1.json', blockedFile(1));
    seedFile('blocked-2.json', blockedFile(2));
    seedFile('a.json', actionableFile(1));
    seedFile('b.json', actionableFile(2));
    seedFile('c.json', actionableFile(3));
    const cycle1 = computeRescoreQueueDepth(tmpDir, titleById);

    // Cycle 2: one actionable file got scored and cleared (markRescoreComplete
    // deletes it from the flagged set entirely), but a fresh short/stub
    // review landed and immediately hit the deterministic text gate — a
    // realistic pipeline shape where new blocked entries replace departed
    // actionable ones. Raw stays flat at 5; unblocked falls to 2.
    resetShowDir();
    seedFile('blocked-1.json', blockedFile(1));
    seedFile('blocked-2.json', blockedFile(2));
    seedFile('blocked-3.json', blockedFile(3));
    seedFile('a.json', actionableFile(1));
    seedFile('b.json', actionableFile(2));
    const cycle2 = computeRescoreQueueDepth(tmpDir, titleById);

    // Cycle 3: same pattern again. Raw still 5; unblocked falls to 1.
    resetShowDir();
    seedFile('blocked-1.json', blockedFile(1));
    seedFile('blocked-2.json', blockedFile(2));
    seedFile('blocked-3.json', blockedFile(3));
    seedFile('blocked-4.json', blockedFile(4));
    seedFile('a.json', actionableFile(1));
    const cycle3 = computeRescoreQueueDepth(tmpDir, titleById);

    const rawSeries = [cycle1, cycle2, cycle3].map((c) => c.totalFlagged);
    const actionableSeries = [cycle1, cycle2, cycle3].map((c) => c.unblocked);

    assert.deepEqual(rawSeries, [5, 5, 5]);
    assert.deepEqual(actionableSeries, [3, 2, 1]);

    let rawHistory = [];
    let actionableHistory = [];
    for (let i = 0; i < 3; i++) {
      rawHistory = recordProgress(rawHistory, rawSeries[i]);
      actionableHistory = recordProgress(actionableHistory, actionableSeries[i]);
    }

    // The naive raw-based wiring this card is about REPLACING: same-value
    // window across 3 cycles reads as stalled.
    const rawVerdict = isStalled(rawHistory, { cycles: 3, direction: 'down' });
    assert.equal(rawVerdict.stalled, true, 'naive raw-based monitor should false-alarm on flat raw depth');

    // The actual wiring (check-progress-stalls.js loadData() -> unblocked):
    // strictly falling values across 3 cycles correctly reads as moving.
    const actionableVerdict = isStalled(actionableHistory, { cycles: 3, direction: 'down' });
    assert.equal(actionableVerdict.stalled, false, 'actionable-based monitor must not false-alarm while the queue is draining');
    assert.equal(actionableVerdict.reason, 'moving');
  });
});
