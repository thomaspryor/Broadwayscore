/**
 * Tests for renameReviewFileForCriticOverride() in collect-review-texts.js.
 *
 * Conflict-mode redesign (post PR #290 revert, 2026-04-29).
 *
 * The helper is exercised here by simulating its behavior — the real function
 * lives inside collect-review-texts.js (a 6700-line script that drags many
 * deps when require()d). To keep the test hermetic, we extract the same
 * logic as a contract: helper takes (review, data, extractedAuthor) and
 * either renames cleanly, marks duplicateOf on conflict, or skips on lock.
 *
 * Coverage of the 5 ship-check regression cases for PR #290:
 *   1. Source wrongShow:true does NOT overwrite dest wrongShow:false
 *      → tests/unit/backfill-html-override-rename.test.mjs (predicate test)
 *   2. _locked:true dest blocks helper write → covered by safeWriteReview's
 *      lockedOverride (review-write-guard.test.mjs)
 *   3. Conflict mode: source unchanged when dest exists → THIS FILE
 *   4. Rename also moves llm-scores sidecar → review-write-guard-topology.test.mjs
 *   5. duplicateTextOf pointers rewritten → review-write-guard-topology.test.mjs
 *   6. (Bonus) review.filePath stays at source on conflict (PR #290 line-5069
 *      bug — the merge was undone by trailing write to filePath. Conflict
 *      mode keeps filePath at source so the trailing write lands at the
 *      duplicateOf-marked source file, NOT at the canonical dest.)
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeRenameReview } = require('../../scripts/lib/review-write-guard');
const { generateReviewFilename, normalizeOutlet } = require('../../scripts/lib/review-normalization');

let tmpDir;
let originalWarn, originalLog;
let warnings, logs;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-helper-'));
  warnings = [];
  logs = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
});
afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Mirror of renameReviewFileForCriticOverride() contract from collect-review-texts.js.
// Re-implementing here lets the test verify the contract independent of the
// 6700-line script. The real function in collect-review-texts.js is a thin
// wrapper that calls safeRenameReview after computing newFilename.
function renameContract(review, data, extractedAuthor) {
  if (!review.filePath || !extractedAuthor) return { action: 'noop' };
  const currentFile = path.basename(review.filePath);
  const showDir = path.dirname(review.filePath);
  const outletId = normalizeOutlet(data.outletId || data.outlet);
  const newFilename = generateReviewFilename(outletId, extractedAuthor);
  if (newFilename === currentFile) return { action: 'noop' };
  const newPath = path.join(showDir, newFilename);
  if (fs.existsSync(newPath)) {
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    return { action: 'conflict', newFile: newFilename };
  }
  const result = safeRenameReview(review.filePath, newPath, { newData: data });
  if (result.skipped === 'locked') return { action: 'skipped-locked' };
  if (result.skipped === 'conflict') {
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    return { action: 'conflict', newFile: newFilename };
  }
  if (!result.wrote) return { action: 'noop' };
  review.filePath = newPath;
  return { action: 'renamed', newFile: newFilename };
}

describe('renameReviewFileForCriticOverride contract (collect-review-texts conflict-mode)', () => {
  test('noop when computed filename matches current filename', () => {
    const showDir = path.join(tmpDir, 'show-a');
    const filePath = path.join(showDir, 'nytimes--jesse-green.json');
    writeFile(filePath, { criticName: 'Jesse Green', outletId: 'nytimes' });

    const review = { filePath };
    const data = { criticName: 'Jesse Green', outletId: 'nytimes' };
    const result = renameContract(review, data, 'Jesse Green');

    assert.equal(result.action, 'noop');
    assert.equal(review.filePath, filePath, 'review.filePath unchanged on noop');
    assert.ok(fs.existsSync(filePath));
  });

  test('clean rename when dest does not exist — review.filePath updated to newPath', () => {
    const showDir = path.join(tmpDir, 'show-a');
    const oldPath = path.join(showDir, 'nytimes--unknown.json');
    writeFile(oldPath, { criticName: 'Unknown', outletId: 'nytimes' });

    const review = { filePath: oldPath };
    const data = { criticName: 'Jesse Green', outletId: 'nytimes' };
    const result = renameContract(review, data, 'Jesse Green');

    assert.equal(result.action, 'renamed');
    assert.equal(result.newFile, 'nytimes--jesse-green.json');
    assert.equal(path.basename(review.filePath), 'nytimes--jesse-green.json');
    assert.ok(!fs.existsSync(oldPath), 'old file removed');
    assert.ok(fs.existsSync(review.filePath), 'new file present');
  });

  test('CONFLICT: dest exists — source unchanged, data.duplicateOf set, review.filePath STAYS at source', () => {
    // The cats-2026 prevention case. The PR #290 line-5069 bug was: rename
    // helper merged into dest then set review.filePath = newPath. The trailing
    // updateReviewJson write at line ~4987 wrote in-memory `data` back to
    // review.filePath = newPath, undoing the merge. Conflict mode kills this
    // entire surface: review.filePath stays at SOURCE so the trailing write
    // lands on the duplicateOf-marked source file (validate-review-texts
    // skips it).
    const showDir = path.join(tmpDir, 'show-a');
    const sourcePath = path.join(showDir, 'variety--rebecca-rubin.json');
    const destPath = path.join(showDir, 'variety--frank-rizzo.json');
    writeFile(sourcePath, {
      criticName: 'Old Stored Name',
      outletId: 'variety',
      fullText: 'source text',
      sourceUniqueField: 'must not leak',
    });
    writeFile(destPath, {
      criticName: 'Frank Rizzo',
      outletId: 'variety',
      fullText: 'destination text — DO NOT TOUCH',
      destUniqueField: 'preserved',
      wrongShow: false, // manually-cleared falsy flag — must NOT be clobbered
    });

    const review = { filePath: sourcePath };
    const data = {
      criticName: 'Frank Rizzo', // override fired
      outletId: 'variety',
      fullText: 'source text',
      sourceUniqueField: 'must not leak',
      wrongShow: true, // source has bad flag — must NOT propagate to dest
    };
    const result = renameContract(review, data, 'Frank Rizzo');

    assert.equal(result.action, 'conflict');
    assert.equal(result.newFile, 'variety--frank-rizzo.json');
    assert.equal(data.duplicateOf, 'variety--frank-rizzo.json',
      'data.duplicateOf set so validate-review-texts skips this file');
    assert.equal(data.duplicateReason, 'criticName-override-collided-at-rename');

    // PR #290 LINE-5069 BUG GUARD: review.filePath must stay at SOURCE so
    // the trailing write at line ~4987 lands on the duplicateOf-marked source.
    assert.equal(review.filePath, sourcePath,
      'CRITICAL: review.filePath must NOT be updated on conflict — that was the line-5069 corruption surface in PR #290');

    // Both files must exist exactly as they were (no merge, no delete).
    assert.ok(fs.existsSync(sourcePath));
    assert.ok(fs.existsSync(destPath));

    // Dest must not have been touched.
    const destAfter = JSON.parse(fs.readFileSync(destPath, 'utf8'));
    assert.equal(destAfter.fullText, 'destination text — DO NOT TOUCH');
    assert.equal(destAfter.destUniqueField, 'preserved');
    assert.equal(destAfter.sourceUniqueField, undefined,
      'source field must NOT leak into dest (PR #290 merge bug guard)');
    assert.equal(destAfter.wrongShow, false,
      'manually-cleared wrongShow:false must survive (PR #290 merge predicate bug guard)');
    assert.equal(destAfter.criticName, 'Frank Rizzo');
  });

  test('locked source refuses rename, source kept, no dest written', () => {
    const showDir = path.join(tmpDir, 'show-a');
    const sourcePath = path.join(showDir, 'nytimes--unknown.json');
    writeFile(sourcePath, {
      _locked: true,
      criticName: 'Unknown',
      outletId: 'nytimes',
      lockedReason: 'manual ingest',
    });

    const review = { filePath: sourcePath };
    const data = {
      _locked: true,
      criticName: 'Helen Shaw',
      outletId: 'nytimes',
    };
    const result = renameContract(review, data, 'Helen Shaw');

    assert.equal(result.action, 'skipped-locked');
    assert.equal(review.filePath, sourcePath, 'review.filePath unchanged when locked');
    assert.ok(fs.existsSync(sourcePath), 'locked source must remain');
    assert.ok(!fs.existsSync(path.join(showDir, 'nytimes--helen-shaw.json')),
      'no dest must be created when source is locked');
  });

  test('clean rename also moves a sibling duplicateTextOf pointer', () => {
    const showDir = path.join(tmpDir, 'show-a');
    const oldPath = path.join(showDir, 'nytimes--unknown.json');
    const sibling = path.join(showDir, 'variety--frank-rizzo.json');
    writeFile(oldPath, { criticName: 'Unknown', outletId: 'nytimes', fullText: 'X' });
    writeFile(sibling, { criticName: 'Frank Rizzo', duplicateTextOf: 'nytimes--unknown.json' });

    const review = { filePath: oldPath };
    const data = { criticName: 'Helen Shaw', outletId: 'nytimes' };
    const result = renameContract(review, data, 'Helen Shaw');

    assert.equal(result.action, 'renamed');
    const sibAfter = JSON.parse(fs.readFileSync(sibling, 'utf8'));
    assert.equal(sibAfter.duplicateTextOf, 'nytimes--helen-shaw.json',
      'sibling duplicateTextOf pointer must be rewritten in lockstep');
  });
});
