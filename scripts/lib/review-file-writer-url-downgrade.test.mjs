/**
 * First-URL-set path regression guard (#1416 ship-check finding, 2026-08-14).
 *
 * createOrMergeReviewFile() has two url-adoption branches for an existing
 * (already-created) file: maybeUpgradeUrl() (guarded by isUrlSwapRegression),
 * and a fallback that fires only when the file has NO url yet. Before this
 * fix, the fallback only checked slugLooksLikeDifferentShow — a wrong-
 * production candidate (same show, prior run) that maybeUpgradeUrl correctly
 * refused fell through and was silently adopted anyway. Uses the real
 * hamilton-2015 show record (stable dates, long-running, won't drift).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

test('first-url-set path refuses a candidate dated outside the show window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-downgrade-'));
  try {
    // Stub: create the file with no url (a record another producer created
    // without a URL yet — e.g. a name-only aggregator citation). Uses a
    // registered outlet (nytimes) so the domain-validation guard doesn't
    // interfere with the url-adoption check under test.
    const created = createOrMergeReviewFile('hamilton-2015', {
      outletId: 'nytimes',
      outlet: 'The New York Times',
      criticName: 'Jane Doe Downgrade Test',
      source: 'test',
      fields: { showNotMentioned: false },
    }, { reviewTextsDir: dir });
    assert.equal(created.action, 'new');
    const stubBefore = JSON.parse(fs.readFileSync(created.filepath, 'utf8'));
    assert.ok(!stubBefore.url, 'stub starts with no url');

    // Candidate url dated a decade before Hamilton's 2015-07-13 preview start
    // — same show, but a wrong-production date signature.
    const merged = createOrMergeReviewFile('hamilton-2015', {
      outletId: 'nytimes',
      outlet: 'The New York Times',
      criticName: 'Jane Doe Downgrade Test',
      url: 'https://www.nytimes.com/2005/01/15/theater/hamilton-review.html',
      source: 'test',
      fields: {},
    }, { reviewTextsDir: dir });

    const after = JSON.parse(fs.readFileSync(merged.filepath, 'utf8'));
    assert.ok(!after.url, 'regressing candidate url is refused, not adopted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first-url-set path still adopts an in-window candidate url', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-downgrade-ok-'));
  try {
    const created = createOrMergeReviewFile('hamilton-2015', {
      outletId: 'nytimes',
      outlet: 'The New York Times',
      criticName: 'John Roe Downgrade Test',
      source: 'test',
      fields: {},
    }, { reviewTextsDir: dir });
    assert.equal(created.action, 'new');

    const merged = createOrMergeReviewFile('hamilton-2015', {
      outletId: 'nytimes',
      outlet: 'The New York Times',
      criticName: 'John Roe Downgrade Test',
      url: 'https://www.nytimes.com/2015/08/10/theater/hamilton-review.html',
      source: 'test',
      fields: {},
    }, { reviewTextsDir: dir });

    const after = JSON.parse(fs.readFileSync(merged.filepath, 'utf8'));
    assert.equal(after.url, 'https://www.nytimes.com/2015/08/10/theater/hamilton-review.html', 'in-window candidate is adopted normally');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
