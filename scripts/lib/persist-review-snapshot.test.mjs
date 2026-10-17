/**
 * BRO-3168: recover-explicit-ratings.js writes merge onto the current disk
 * record instead of clobbering it with the snapshot it read minutes earlier.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeOntoDisk, persistReviewSnapshot } = require('./persist-review-snapshot.js');
const { setExtractedScore } = require('./score-routing.js');

const read = () => ({
  outletId: 'theaterlife', criticName: 'Gary Wien', url: 'https://theaterlife.com/x',
  originalScore: null, assignedScore: 72, scoreSource: 'llm-v6',
});

test('a clear that landed on disk mid-run beats the recovered score', () => {
  const snapshot = read();
  const data = read();
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'text-stars' });
  data.scoreRecoveredAt = '2026-10-12T00:00:00Z';
  const disk = { ...read(), originalScoreCleared: true, originalScoreClearedReason: 'combined-column star belongs to another show' };
  const { merged, droppedScore } = mergeOntoDisk(snapshot, data, disk);
  assert.equal(droppedScore, true);
  assert.equal(merged.originalScore, null);
  assert.equal(merged.originalScoreCleared, true);
  assert.equal(merged.scoreSource, 'llm-v6');
  assert.equal(merged.scoreRecoveredAt, undefined);
});

test('a clear re-made for a new reason mid-run is not retired by the stale copy', () => {
  const cleared = { ...read(), originalScoreCleared: true, originalScoreClearedReason: 'extraction-no-evidence' };
  const snapshot = JSON.parse(JSON.stringify(cleared));
  const data = JSON.parse(JSON.stringify(cleared));
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'timeout-svg-stars' });
  assert.equal(data.originalScoreCleared, undefined, 'precondition: the structural star retired the clear in memory');
  const disk = { ...cleared, originalScoreClearedReason: 'human: star belongs to the other show in the column' };
  const { merged, droppedScore } = mergeOntoDisk(snapshot, data, disk);
  assert.equal(droppedScore, true);
  assert.equal(merged.originalScoreCleared, true);
  assert.equal(merged.originalScoreClearedReason, disk.originalScoreClearedReason);
  assert.equal(merged.originalScoreClearSupersededBy, undefined);
  assert.equal(merged.originalScore, null);
});

test('fields the caller did not touch keep the concurrent disk value; its own edits win', () => {
  const snapshot = read();
  const data = { ...read(), urlSource: 'serp-recovery', url: 'https://theaterlife.com/y' };
  const disk = { ...read(), assignedScore: 65, humanReviewScore: 65 };
  const { merged, droppedScore, keptDiskFields } = mergeOntoDisk(snapshot, data, disk);
  assert.equal(droppedScore, false);
  assert.equal(merged.assignedScore, 65, 'a concurrent rescore survives');
  assert.equal(merged.humanReviewScore, 65, 'a field only disk has survives');
  assert.equal(merged.url, 'https://theaterlife.com/y');
  assert.deepEqual(keptDiskFields, ['assignedScore']);
});

test('without a concurrent clear the recovered score is written', () => {
  const snapshot = read();
  const data = read();
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'text-stars' });
  const { merged } = mergeOntoDisk(snapshot, data, read());
  assert.equal(merged.originalScore, '4/5');
});

test('a clear picked up by an earlier write in the run still blocks a later score', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-snap-'));
  const filePath = path.join(dir, 'theaterlife--gary-wien.json');
  fs.writeFileSync(filePath, JSON.stringify(read()));
  const data = read();
  const review = { filePath, data, snapshot: read() };
  fs.writeFileSync(filePath, JSON.stringify({ ...read(), originalScoreCleared: true, originalScoreClearedReason: 'human' }));
  data.urlSource = 'serp-recovery'; // phase 0 write: picks the clear up into the baseline
  persistReviewSnapshot(review, () => {});
  assert.equal(review.snapshot.originalScoreCleared, true);
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'text-stars' });
  const r = persistReviewSnapshot(review, () => {});
  assert.equal(r.droppedScore, true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.originalScore, null);
  assert.equal(onDisk.originalScoreCleared, true);
  assert.equal(onDisk.urlSource, 'serp-recovery');
});

test('a structural star retiring the clear it read is written', () => {
  const cleared = { ...read(), originalScoreCleared: true, originalScoreClearedReason: 'extraction-no-evidence' };
  const data = JSON.parse(JSON.stringify(cleared));
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'timeout-svg-stars' });
  const { merged, droppedScore } = mergeOntoDisk(cleared, data, JSON.parse(JSON.stringify(cleared)));
  assert.equal(droppedScore, false);
  assert.equal(merged.originalScore, '4/5');
  assert.equal(merged.originalScoreCleared, undefined);
  assert.equal(merged.originalScoreClearSupersededBy, 'timeout-svg-stars');
});

test('persist re-reads the file, writes the merge, and rebases the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-snap-'));
  const filePath = path.join(dir, 'theaterlife--gary-wien.json');
  fs.writeFileSync(filePath, JSON.stringify(read()));
  const data = read();
  const review = { filePath, data, snapshot: read() };
  // another writer clears the score while this run works
  fs.writeFileSync(filePath, JSON.stringify({ ...read(), originalScoreCleared: true }));
  setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'text-stars' });
  const r = persistReviewSnapshot(review, () => {});
  assert.equal(r.droppedScore, true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.originalScoreCleared, true);
  assert.equal(onDisk.originalScore, null);
  assert.equal(review.data, data, 'review.data is updated in place');
  assert.equal(data.originalScoreCleared, true);
  assert.deepEqual(review.snapshot, onDisk);
});
