// BRO-7890 item 7: the lane inbox drain minted an empty columbiaspectator-com--light-dohrne.json beside the existing
// file for the SAME URL, because findExistingReviewFile's URL pass only looks inside the same outlet id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization.js');

function showDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7890-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}
const URL_SPEC = 'https://www.columbiaspectator.com/arts-and-culture/2026/11/19/review-much-ado/';

test('an unregistered site under two outlet spellings: the existing file is found by URL', () => {
  const dir = showDir({ 'columbia-spectator--jane-doe.json': { outletId: 'columbia-spectator', criticName: 'Jane Doe', url: URL_SPEC, fullText: 'x'.repeat(3000) } });
  const hit = findExistingReviewFile(dir, 'columbiaspectator-com', 'Light Dohrne', URL_SPEC);
  assert.ok(hit, 'existing file must be matched');
  assert.equal(hit.filename, 'columbia-spectator--jane-doe.json');
});

test('a registered outlet never adopts another outlet\'s file by URL (pass-0 contract holds)', () => {
  const u = 'https://www.nytimes.com/2026/11/19/theater/much-ado-review.html';
  const dir = showDir({ 'nytimes--helen-shaw.json': { outletId: 'nytimes', criticName: 'Helen Shaw', url: u } });
  assert.equal(findExistingReviewFile(dir, 'variety', 'Unknown', u), null);
});

test('a shared aggregator roundup URL is never adopted across outlets', () => {
  const roundup = 'https://www.thestage.co.uk/review-round-ups/much-ado-reviews';
  const dir = showDir({ 'telegraph--dominic-cavendish.json': { outletId: 'telegraph', criticName: 'Dominic Cavendish', url: roundup } });
  assert.equal(findExistingReviewFile(dir, 'guardian', 'Arifa Akbar', roundup), null);
});

test('a registered outlet star-stub on another registered outlet\'s page is not adopted', () => {
  const page = 'https://www.whatsonstage.com/news/much-ado-reviews_12345/';
  const dir = showDir({ 'telegraph--dominic-cavendish.json': { outletId: 'telegraph', criticName: 'Dominic Cavendish', url: page } });
  assert.equal(findExistingReviewFile(dir, 'guardian', 'Arifa Akbar', page), null);
});

test('two files already on the URL: ambiguous, nothing adopted', () => {
  const dir = showDir({
    'a-site--x.json': { outletId: 'a-site', criticName: 'X', url: URL_SPEC },
    'b-site--y.json': { outletId: 'b-site', criticName: 'Y', url: URL_SPEC },
  });
  assert.equal(findExistingReviewFile(dir, 'columbiaspectator-com', 'Z', URL_SPEC), null);
});

test('an unregistered outlet name that is NOT the URL host placeholder is never adopted', () => {
  const dir = showDir({ 'columbia-spectator--jane-doe.json': { outletId: 'columbia-spectator', criticName: 'Jane Doe', url: URL_SPEC } });
  assert.equal(findExistingReviewFile(dir, 'Some Theatre Blog', 'Light Dohrne', URL_SPEC), null);
  assert.ok(findExistingReviewFile(dir, 'columbiaspectator', 'Light Dohrne', URL_SPEC), 'host without TLD is the same placeholder');
});
