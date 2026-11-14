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
const { readReviewForUpdate, renameReviewSnapshot, mergeOntoDisk, persistReviewSnapshot } = require('./persist-review-snapshot.js');
const { setExtractedScore } = require('./score-routing.js');

const read = () => ({
  outletId: 'theaterlife', criticName: 'Gary Wien', url: 'https://theaterlife.com/x',
  originalScore: null, assignedScore: 72, scoreSource: 'llm-v6',
});

function scratchReview(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'review.json');
  fs.writeFileSync(filePath, JSON.stringify(read()));
  return filePath;
}

test('read helper captures the baseline before slow work and object spreads', t => {
  const filePath = scratchReview(t);
  const data = readReviewForUpdate(filePath);
  const updated = { ...data, fullText: 'Recovered article body', originalScore: '4/5' };
  const disk = { ...read(), originalScoreCleared: true, originalScoreClearedReason: 'operator', assignedScore: 63 };
  fs.writeFileSync(filePath, JSON.stringify(disk));
  const result = persistReviewSnapshot({ filePath, data: updated }, () => {});
  assert.equal(result.droppedScore, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ...disk, fullText: updated.fullText });
  assert.deepEqual(JSON.parse(JSON.stringify(data)), read(), 'baseline metadata never enters JSON');
});

test('successive writes using a spread rebase the carried baseline', t => {
  const filePath = scratchReview(t);
  const data = { ...readReviewForUpdate(filePath), textFetchedAt: 'today' };
  persistReviewSnapshot({ filePath, data, trailingNewline: true }, () => {});
  assert.equal(fs.readFileSync(filePath, 'utf8').endsWith('\n'), true);
  const disk = { ...JSON.parse(fs.readFileSync(filePath, 'utf8')), textFetchedAt: 'newer', assignedScore: 69 };
  fs.writeFileSync(filePath, JSON.stringify(disk));
  data.httpStatus = 404;
  persistReviewSnapshot({ filePath, data }, () => {});
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ...disk, httpStatus: 404 });
});

test('one-shot writes retain intentional deletions and unrelated concurrent fields', t => {
  const filePath = scratchReview(t);
  const data = readReviewForUpdate(filePath);
  delete data.scoreSource;
  fs.writeFileSync(filePath, JSON.stringify({ ...read(), contentVerification: { isValid: true } }));
  persistReviewSnapshot({ filePath, data }, () => {});
  const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(disk.scoreSource, undefined);
  assert.deepEqual(disk.contentVerification, { isValid: true });
});

test('missing baselines and cross-file snapshots fail before writing', t => {
  const filePath = scratchReview(t);
  assert.throws(() => persistReviewSnapshot({ filePath, data: read() }), /requires a snapshot/);
  const data = readReviewForUpdate(filePath);
  assert.throws(() => persistReviewSnapshot({ filePath: `${filePath}.other`, data }), /different file/);
  assert.equal(fs.existsSync(`${filePath}.other`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), read());
});

test('a mid-update byline rename preserves concurrent clears and rebases later writes', t => {
  const filePath = scratchReview(t);
  const newPath = path.join(path.dirname(filePath), 'named-review.json');
  const data = readReviewForUpdate(filePath);
  data.criticName = 'Recovered Byline';
  const disk = { ...read(), originalScore: null, originalScoreCleared: true, originalScoreClearedReason: 'operator' };
  fs.writeFileSync(filePath, JSON.stringify(disk));
  const result = renameReviewSnapshot({ filePath, data }, newPath, {}, () => {});
  assert.equal(result.wrote, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(data.originalScoreCleared, true);
  assert.equal(data.criticName, 'Recovered Byline');
  const renamed = JSON.parse(fs.readFileSync(newPath, 'utf8'));
  assert.ok(renamed._renamedFrom);
  data.httpStatus = 200;
  persistReviewSnapshot({ filePath: newPath, data }, () => {});
  assert.deepEqual(JSON.parse(fs.readFileSync(newPath, 'utf8')), { ...renamed, httpStatus: 200 });
});

test('a snapshot rename honors a concurrently locked source without writing it', t => {
  const filePath = scratchReview(t);
  const data = readReviewForUpdate(filePath);
  data.criticName = 'Recovered Byline';
  const locked = { ...read(), _locked: true };
  fs.writeFileSync(filePath, JSON.stringify(locked));
  const newPath = path.join(path.dirname(filePath), 'locked-target.json');
  const result = renameReviewSnapshot({ filePath, data }, newPath, {}, () => {});
  assert.equal(result.skipped, 'locked');
  assert.equal(fs.existsSync(newPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), locked);
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

test('a clear picked up by an earlier write in the run still blocks a later score', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'theaterlife--gary-wien.json');
  fs.writeFileSync(filePath, JSON.stringify(read()));
  const data = read();
  const review = { filePath, data, snapshot: read() };
  fs.writeFileSync(filePath, JSON.stringify({ ...read(), originalScoreCleared: true, originalScoreClearedReason: 'human' }));
  data.urlSource = 'serp-recovery'; // phase 0 write: picks the clear up into the baseline
  persistReviewSnapshot(review, () => {});
  assert.equal(review.snapshot.originalScoreCleared, true);
  const routed = setExtractedScore(data, { value: '4/5', normalizedValue: 80, source: 'text-stars' });
  assert.equal(routed.blocked, true, 'the shared writer already knows this clear');
  const r = persistReviewSnapshot(review, () => {});
  assert.equal(r.droppedScore, false, 'no score edit reaches persistence');
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

test('persist re-reads the file, writes the merge, and rebases the snapshot', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

for (const fixedUrl of ['', 'https://www.express.co.uk/entertainment/theatre/1845793/stephen-daldry-stranger-things-theatrical-prequel-dazzling-show']) {
  for (const concurrent of [false, true]) {
    test(`SERP recovery cannot overwrite an approved URL fix (${fixedUrl || 'empty'}, concurrent=${concurrent}) with a listing`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-approved-url-'));
      try {
        const filePath = path.join(dir, 'express-uk--neil-norman.json');
        const original = { ...read(), outletId: 'express-uk', criticName: 'Neil Norman', url: '' };
        const disk = { ...original, url: fixedUrl,
          approvedFixes: [{ fixId: 'approved-url-fix', field: 'url', newValue: fixedUrl }] };
        const snapshot = concurrent ? original : disk;
        const review = { filePath, snapshot: structuredClone(snapshot),
          data: { ...structuredClone(snapshot), url: 'https://www.express.co.uk/latest/theatre',
            urlSource: 'serp-recovery', fullText: 'Wrong listing page body', assignedScore: 99 } };
        fs.writeFileSync(filePath, JSON.stringify(disk));
        const result = persistReviewSnapshot(review, () => {});
        assert.equal(result.droppedUrl, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), disk);
        assert.deepEqual(review.data, disk, 'later phases must see the approved URL');
        assert.deepEqual(review.snapshot, disk);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('an approved non-URL edit does not block recovery and a genuine review URL can fill a cleared URL', () => {
  const snapshot = { ...read(), url: '',
    approvedFixes: [{ fixId: 'score-fix', field: 'originalScore', newValue: '4/5' }] };
  const listing = { ...snapshot, url: 'https://www.express.co.uk/latest/theatre' };
  assert.equal(mergeOntoDisk(snapshot, listing, snapshot).merged.url, listing.url);
  const fixed = { ...snapshot, approvedFixes: [{ fixId: 'url-fix', field: 'url', newValue: '' }] };
  const recovered = { ...fixed, url: 'https://www.express.co.uk/entertainment/theatre/1845793/stephen-daldry-stranger-things-theatrical-prequel-dazzling-show' };
  assert.equal(mergeOntoDisk(fixed, recovered, fixed).merged.url, recovered.url);
});

test('the latest approved URL fix wins and an explicitly approved listing is retained', () => {
  const listing = 'https://www.talkinbroadway.com/page/world/index.html';
  const snapshot = { ...read(), url: '', approvedFixes: [
    { fixId: 'old-clear', field: 'url', newValue: '' },
    { fixId: 'approved-listing', field: 'url', newValue: listing },
  ] };
  const data = { ...snapshot, url: listing };
  assert.equal(mergeOntoDisk(snapshot, data, snapshot).merged.url, listing);
  const cleared = { ...snapshot, approvedFixes: [...snapshot.approvedFixes,
    { fixId: 'new-clear', field: 'url', newValue: '' }] };
  const result = mergeOntoDisk(cleared, { ...cleared, url: listing }, cleared);
  assert.equal(result.droppedUrl, true);
  assert.equal(result.merged.url, '');
});
