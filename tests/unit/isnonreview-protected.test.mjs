/**
 * BRO-3106: isNonReview / isNonReviewReason were missing from PROTECTED_FIELDS,
 * so a manual "not a review" verdict (the-story-west-end-2026's Spectator
 * contact page, a list of staff emails ingested as a T2 review) had no
 * write-guard protection, while wrongShow/wrongProduction/isNotReview did.
 * The push-review-texts action and restore-protected-fields.js both read
 * PROTECTED_FIELDS + isIntentionalClear from review-write-guard.js, so these
 * cases cover all three sides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeWriteReview, PROTECTED_FIELDS, isIntentionalClear } =
  require('../../scripts/lib/review-write-guard.js');

const FLAGGED = {
  showId: 'the-story-west-end-2026',
  outletId: 'the-spectator-uk',
  outlet: 'The Spectator',
  criticName: 'Unknown',
  url: 'https://www.spectator.co.uk/submit/',
  isNonReview: true,
  isNonReviewReason: 'manual (not a review): editorial contact page',
};

function tmpFile(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3106-'));
  const fp = path.join(dir, 'the-spectator-uk--unknown.json');
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  return { dir, fp };
}

test('isNonReview and isNonReviewReason are PROTECTED_FIELDS', () => {
  assert.ok(PROTECTED_FIELDS.includes('isNonReview'));
  assert.ok(PROTECTED_FIELDS.includes('isNonReviewReason'));
});

test('a writer that omits the verdict cannot drop it', () => {
  const { dir, fp } = tmpFile(FLAGGED);
  const rewrite = { ...FLAGGED };
  delete rewrite.isNonReview;
  delete rewrite.isNonReviewReason;
  safeWriteReview(fp, rewrite, { merge: false });
  const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(after.isNonReview, true);
  assert.equal(after.isNonReviewReason, FLAGGED.isNonReviewReason);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit clear (isNonReview=false, reason null) is honored, not resurrected', () => {
  const { dir, fp } = tmpFile(FLAGGED);
  safeWriteReview(fp, { ...FLAGGED, isNonReview: false, isNonReviewReason: null, nonReviewManualClear: true });
  const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(after.isNonReview, false);
  assert.ok(after.isNonReviewReason == null, 'reason stays cleared');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push-time restore treats a cleared reason as intentional, a dropped flag as loss', () => {
  const committed = { isNonReview: true, isNonReviewReason: 'x' };
  assert.equal(isIntentionalClear('isNonReviewReason', { isNonReview: false, isNonReviewReason: null }, committed), true);
  assert.equal(isIntentionalClear('isNonReview', { nonReviewManualClear: true }, committed), true);
  assert.equal(isIntentionalClear('isNonReview', {}, committed), false);
  assert.equal(isIntentionalClear('isNonReviewReason', { isNonReview: true }, committed), false);
});

// The class (BRO-3106 section 3): the shared writer refuses a site's root
// utility page from any source, so outlet-listing-poller cannot ingest
// /submit/ or /contact-us as a review again.
test('createOrMergeReviewFile refuses a site utility page for a new file', () => {
  const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3106-writer-'));
  fs.mkdirSync(path.join(root, 'the-story-west-end-2026'), { recursive: true });
  const r = createOrMergeReviewFile('the-story-west-end-2026', {
    outletId: 'the-spectator-uk', outlet: 'The Spectator', criticName: 'Unknown',
    url: 'https://www.spectator.co.uk/submit/', source: 'outlet-listing-poller', fields: {},
  }, { reviewTextsDir: root });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /^site-utility-url/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'the-story-west-end-2026')), []);
  const ok = createOrMergeReviewFile('the-story-west-end-2026', {
    outletId: 'the-spectator-uk', outlet: 'The Spectator', criticName: 'Unknown',
    url: 'https://www.spectator.co.uk/article/the-story-review/', source: 'outlet-listing-poller', fields: {},
  }, { reviewTextsDir: root, dryRun: true });
  assert.ok(!String(ok.reason || '').startsWith('site-utility-url'), 'a real article path is not refused');
  fs.rmSync(root, { recursive: true, force: true });
});
