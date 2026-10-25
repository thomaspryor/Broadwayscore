/**
 * S2-T4: firstSeenAt is the immutable retrieval clock, stamped once at file
 * creation and never changed on merge. Centralized in review-file-writer so both
 * the shared writer AND gather-reviews' direct-write path behave identically.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile, stampFirstSeen } = require('../../scripts/lib/review-file-writer');

describe('firstSeenAt — immutable creation clock', () => {
  test('stampFirstSeen sets on a fresh review, preserves an existing value', () => {
    const fresh = { outletId: 'variety', criticName: 'A', url: 'u' };
    stampFirstSeen(fresh);
    assert.match(fresh.firstSeenAt, /^\d{4}-\d{2}-\d{2}T/, 'ISO timestamp stamped');
    const old = { firstSeenAt: '2020-01-01T00:00:00.000Z' };
    stampFirstSeen(old);
    assert.equal(old.firstSeenAt, '2020-01-01T00:00:00.000Z', 'existing value is immutable');
  });

  test('createOrMergeReviewFile stamps firstSeenAt on a newly-created file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-fs-'));
    const res = createOrMergeReviewFile('fs-show', {
      outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
      url: 'https://variety.com/2026/legit/reviews/fs-review-1',
      fields: { fullText: 'A wonderful, full-length review of the show with lots of detail. '.repeat(6) },
    }, { reviewTextsDir: dir });
    assert.equal(res.action, 'new');
    const data = JSON.parse(fs.readFileSync(res.filepath, 'utf8'));
    assert.match(data.firstSeenAt, /^\d{4}-\d{2}-\d{2}T/, 'new file carries firstSeenAt');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a merge onto an existing file does NOT change firstSeenAt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-fsm-'));
    const input = {
      outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
      url: 'https://variety.com/2026/legit/reviews/fs-review-2',
      fields: { fullText: 'Initial extraction body text, long enough to be a real review. '.repeat(5) },
    };
    const first = createOrMergeReviewFile('fsm-show', input, { reviewTextsDir: dir });
    assert.equal(first.action, 'new');
    const original = JSON.parse(fs.readFileSync(first.filepath, 'utf8')).firstSeenAt;
    assert.ok(original, 'firstSeenAt present after create');

    // Force a different clock, then merge more text onto the same file.
    const merged = createOrMergeReviewFile('fsm-show', {
      ...input,
      fields: { fullText: 'A LONGER, richer body added on a later pass with even more detail. '.repeat(8) },
      source: 'later-pass',
    }, { reviewTextsDir: dir });
    assert.ok(['updated', 'skipped'].includes(merged.action), `merge path, got ${merged.action}`);
    const after = JSON.parse(fs.readFileSync(first.filepath, 'utf8')).firstSeenAt;
    assert.equal(after, original, 'firstSeenAt is immutable across merge');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
