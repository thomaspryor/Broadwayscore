import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasScoredReviews } = require('./scoring-progress-gate.js');

test('all-rejected batch (processed=0, filesModified>0) returns true', () => {
  // Reproduces the orphan-unscored-wp-cleared-2026-04-29 batch: 19 files hit
  // rejection branches, zero scored, but every rejection wrote state to disk.
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 19, skipped: 19 }), true);
});

test('genuinely nothing happened (all counters zero) returns false', () => {
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 0, skipped: 0 }), false);
});

test('garbage-only skip batch with no disk writes returns false', () => {
  // Reviews skipped for insufficient text never reach saveReviewFile().
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 0, skipped: 12 }), false);
});

test('normal mixed batch (some scored, some rejected) returns true', () => {
  assert.equal(hasScoredReviews({ processed: 40, filesModified: 50, skipped: 10 }), true);
});

test('legacy progress file without filesModified falls back to processed', () => {
  assert.equal(hasScoredReviews({ processed: 5, skipped: 2 }), true);
  assert.equal(hasScoredReviews({ processed: 0, skipped: 2 }), false);
});

test('missing or malformed progress returns false', () => {
  assert.equal(hasScoredReviews(null), false);
  assert.equal(hasScoredReviews(undefined), false);
  assert.equal(hasScoredReviews({}), false);
  assert.equal(hasScoredReviews('not an object'), false);
});

// BRO-3108: a run that only re-serialises review files to identical bytes must
// end with filesModified === 0, so the gate reads it as a no-op. saveReviewFile
// in scripts/llm-scoring/index.ts counts a file only when writeFileIfChanged
// reports a real write.
test('byte-identical rewrite is not counted, so a no-op run reads as nothing scored', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { writeFileIfChanged } = require('./write-if-changed.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3108-'));
  try {
    const file = path.join(dir, 'outlet--critic.json');
    const body = JSON.stringify({ assignedScore: 77, url: 'https://example.com/r' }, null, 2) + '\n';
    fs.writeFileSync(file, body);
    const mtimeBefore = fs.statSync(file).mtimeMs;

    let filesModified = 0;
    if (writeFileIfChanged(file, body)) filesModified++;
    assert.equal(filesModified, 0);
    assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
    assert.equal(hasScoredReviews({ processed: 0, skipped: 1, filesModified }), false);

    const changed = JSON.stringify({ assignedScore: 78, url: 'https://example.com/r' }, null, 2) + '\n';
    if (writeFileIfChanged(file, changed)) filesModified++;
    assert.equal(filesModified, 1);
    assert.equal(fs.readFileSync(file, 'utf-8'), changed);
    assert.equal(hasScoredReviews({ processed: 0, skipped: 1, filesModified }), true);

    const fresh = path.join(dir, 'new.json');
    assert.equal(writeFileIfChanged(fresh, body), true);
    assert.equal(fs.readFileSync(fresh, 'utf-8'), body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveReviewFile counts filesModified only through writeFileIfChanged', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'llm-scoring', 'index.ts'), 'utf-8');
  const body = src.slice(src.indexOf('function saveReviewFile('), src.indexOf('function maybeStampBlockedRescore('));
  assert.match(body, /^\s*if \(writeFileIfChanged\(filePath, .*\)\) filesModifiedCount\+\+;$/m);
  assert.doesNotMatch(body, /fs\.writeFileSync/);
});
