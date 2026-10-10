/**
 * Tests for scripts/lib/ob-transfer-guard.js (BRO-4192).
 *
 * Run: node --test scripts/lib/ob-transfer-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isValidBroadwayCopy, isDatedWithinObRun, shouldClearStaleObTransfer } = require('./ob-transfer-guard.js');

const bwShow = { id: 'cats-the-jellicle-ball-2026', previewsStartDate: '2026-03-18', openingDate: '2026-04-07' };
const obShow = { id: 'cats-the-jellicle-ball-off-broadway-2024', openingDate: '2024-06-10', closingDate: '2024-08-10' };
const url = 'https://www.nytimes.com/2024/06/20/theater/cats-the-jellicle-ball-review.html';

test('a Broadway-dir copy dated in the Broadway run counts', () => {
  assert.equal(isValidBroadwayCopy({ url, publishDate: '2026-04-08' }, bwShow), true);
});

test('a misfiled OB-era copy in the Broadway dir does NOT count', () => {
  assert.equal(isValidBroadwayCopy({ url, publishDate: 'June 20th, 2024' }, bwShow), false);
});

test('a flagged Broadway-dir copy does NOT count; a manually cleared one does', () => {
  assert.equal(isValidBroadwayCopy({ url, publishDate: '2026-04-08', wrongProduction: true }, bwShow), false);
  assert.equal(isValidBroadwayCopy({ url, publishDate: '2026-04-08', wrongProduction: true, wrongProductionManualClear: true }, bwShow), true);
});

test('undated Broadway-dir copy keeps historical behavior (counts)', () => {
  assert.equal(isValidBroadwayCopy({ url }, bwShow), true);
  assert.equal(isValidBroadwayCopy({ publishDate: '2026-04-08' }, bwShow), false, 'no url → cannot collide');
});

test('isDatedWithinObRun handles ordinal dates and the run window', () => {
  assert.equal(isDatedWithinObRun({ publishDate: 'June 20th, 2024' }, obShow), true);
  assert.equal(isDatedWithinObRun({ publishDate: '2024-08-20' }, obShow), true, 'within 14-day grace after closing');
  assert.equal(isDatedWithinObRun({ publishDate: '2025-01-01' }, obShow), false);
  assert.equal(isDatedWithinObRun({ publishDate: '2015-11-29' }, obShow), false, 'earlier production');
  assert.equal(isDatedWithinObRun({}, obShow), false, 'undated');
});

const flagged = (extra = {}) => ({ url, publishDate: 'June 20th, 2024', wrongProduction: true,
  wrongProductionReason: 'ob-broadway-transfer', ...extra });

test('stale ob-broadway-transfer flag on in-run OB coverage is cleared (the Cats NYT pick)', () => {
  assert.equal(shouldClearStaleObTransfer(flagged(), false, obShow), true);
});

test('flag stays while a valid Broadway copy still shares the URL', () => {
  assert.equal(shouldClearStaleObTransfer(flagged(), true, obShow), false);
});

test('flag stays on reviews of other productions and undated files', () => {
  assert.equal(shouldClearStaleObTransfer(flagged({ publishDate: 'October 9th, 2024' }), false,
    { openingDate: '2026-01-30', closingDate: '2026-03-01' }), false);
  assert.equal(shouldClearStaleObTransfer(flagged({ publishDate: undefined }), false, obShow), false);
});

test('never touches operator-confirmed or differently-reasoned flags', () => {
  assert.equal(shouldClearStaleObTransfer(flagged({ humanReviewedWrongProduction: true }), false, obShow), false);
  assert.equal(shouldClearStaleObTransfer(flagged({ wrongProductionReason: 'pre-opening' }), false, obShow), false);
  assert.equal(shouldClearStaleObTransfer({ ...flagged(), wrongProduction: false }, false, obShow), false);
});

test('review-fix: locked files and far-out dates in open-ended runs are never released', () => {
  const openOb = { id: 'x-off-broadway', openingDate: '2024-01-10', closingDate: null };
  const rec = { wrongProduction: true, wrongProductionReason: 'ob-broadway-transfer', publishDate: 'January 12, 2024' };
  assert.equal(shouldClearStaleObTransfer(rec, false, openOb), true);
  assert.equal(shouldClearStaleObTransfer({ ...rec, _locked: true }, false, openOb), false);
  assert.equal(shouldClearStaleObTransfer({ ...rec, publishDate: 'March 1, 2026' }, false, openOb), false);
});

test('review-fix: a Broadway copy up to 90 days early still counts (matches the pre-opening guard)', () => {
  const bw = { id: 'x-2024', previewsStartDate: '2024-06-01', openingDate: '2024-06-20' };
  assert.equal(isValidBroadwayCopy({ url: 'u', publishDate: 'April 1, 2024' }, bw), true);
  assert.equal(isValidBroadwayCopy({ url: 'u', publishDate: 'January 1, 2024' }, bw), false);
});
