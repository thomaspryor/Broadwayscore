/**
 * BRO-4101 — gather-reviews.js's createReviewFile() is a SEPARATE write
 * chokepoint from review-file-writer.js's createOrMergeReviewFile() (its own
 * independent implementation, not a caller of the shared one) and is what
 * gather-reviews.js itself, opening-night-poller.js, and
 * opening-night-checklist.js actually persist through. Confirmed via
 * ship-check adversarial review that this path carried none of the
 * NAMED_NON_REVIEW_URL_PATTERNS protection the other three chokepoints got.
 *
 * createReviewFile() creates the show directory as its very first statement
 * (pre-existing behavior, unrelated to this fix) — this test uses an
 * obviously-scratch showId and removes the directory afterward so it never
 * pollutes a real show's review-texts folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { createReviewFile } = require('./gather-reviews.js');

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SHOW_ID = 'zzz-scratch-bro-4101-named-non-review-test';
const SHOW_DIR = path.join(__dirname, '..', 'data', 'review-texts', SHOW_ID);

const quiet = (fn) => {
  const l = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = l; }
};

test.after(() => {
  fs.rmSync(SHOW_DIR, { recursive: true, force: true });
});

test('createReviewFile rejects londontheatre.co.uk/show/NNNN ticket page', () => {
  const result = quiet(() => createReviewFile(SHOW_ID, {
    outlet: 'London Theatre',
    criticName: 'Unknown',
    url: 'https://www.londontheatre.co.uk/show/47207-the-last-ship',
    source: 'serp-discovery',
  }));
  assert.equal(result, 'namedNonReviewUrl');
  assert.equal(fs.existsSync(path.join(SHOW_DIR, 'london-theatre--unknown.json')), false);
});

test('createReviewFile accepts londontheatre.co.uk/reviews/ (same host, real reviews path)', () => {
  const result = quiet(() => createReviewFile(SHOW_ID, {
    outlet: 'London Theatre',
    criticName: 'Marianka Swain',
    url: 'https://www.londontheatre.co.uk/reviews/the-last-ship',
    source: 'serp-discovery',
    fullText: 'A perfectly ordinary review body with more than enough words to pass any text gate that might apply.',
  }));
  assert.notEqual(result, 'namedNonReviewUrl');
});
