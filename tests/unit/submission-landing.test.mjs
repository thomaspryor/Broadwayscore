/**
 * checkSubmissionLanded — issue #908 (Golden Boy / Daily Mail, 2026-09-22).
 * The submission workflow said "Review Successfully Added" for a file the
 * rebuild excluded. The check must answer from reviews.json, not from ingest.
 *
 * Run: node --test tests/unit/submission-landing.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkSubmissionLanded } = require('../../scripts/lib/submission-landing.js');

const SHOW = { id: 'golden-boy-x-2026', openingDate: '2026-09-15' };
const URL_OK = 'https://www.telegraph.co.uk/theatre/golden-boy-review/';
const URL_BAD = 'https://newspaper.dailymail.com/edition/showbiz/theatre/472292/nicely-ripped';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-'));
  const showDir = path.join(dir, SHOW.id);
  fs.mkdirSync(showDir);
  fs.writeFileSync(path.join(showDir, 'telegraph--tfs.json'), JSON.stringify({
    showId: SHOW.id, outletId: 'telegraph', criticName: 'Tristram Fane Saunders', url: URL_OK,
    contentTier: 'complete', fullText: 'a'.repeat(3000),
  }));
  fs.writeFileSync(path.join(showDir, 'daily-mail--patrick-marmion.json'), JSON.stringify({
    showId: SHOW.id, outletId: 'daily-mail', criticName: 'Patrick Marmion', url: URL_BAD,
    contentTier: 'invalid', incompleteReason: 'url_content_mismatch', fullText: 'b'.repeat(900),
  }));
  return dir;
}

const reviews = [{ showId: SHOW.id, outletId: 'telegraph', criticName: 'Tristram Fane Saunders', url: URL_OK }];

test('a review present in reviews.json is landed', () => {
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL_OK + '?utm_source=x', reviews, reviewTextsDir: fixture(), show: SHOW });
  assert.equal(r.landed, true);
  assert.equal(r.reason, null);
});

test('an ingested-but-excluded file is NOT landed, with the exclusion reason', () => {
  const r = checkSubmissionLanded({ showId: SHOW.id, url: URL_BAD, reviews, reviewTextsDir: fixture(), show: SHOW });
  assert.equal(r.landed, false);
  assert.equal(r.reason, 'contentTierInvalid');
});

test('no file for the URL is NOT landed', () => {
  const r = checkSubmissionLanded({ showId: SHOW.id, url: 'https://example.com/none', reviews, reviewTextsDir: fixture(), show: SHOW });
  assert.equal(r.landed, false);
  assert.match(r.reason, /no review file/);
});

test('an older listed review by the same outlet + critic does NOT vouch for an excluded submission', () => {
  const r = checkSubmissionLanded({
    showId: SHOW.id, url: URL_BAD,
    reviews: [...reviews, { showId: SHOW.id, outletId: 'daily-mail', criticName: 'Patrick Marmion', url: 'https://www.dailymail.co.uk/older-piece/' }],
    reviewTextsDir: fixture(), show: SHOW,
  });
  assert.equal(r.landed, false);
});
