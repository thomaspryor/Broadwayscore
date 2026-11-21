import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization.js');

// Reproduces the byline-explosion fix: a review URL is the identity of a review,
// so a re-scrape that extracts a different byline must merge into the existing
// file (matched by URL), not spawn a "whatsonstage--<newbyline>.json" variant.
let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-url-'));
  const url = 'https://www.whatsonstage.com/news/a-midsummer-nights-dream-review_1726521/';
  fs.writeFileSync(path.join(dir, 'whatsonstage--alex-wood.json'),
    JSON.stringify({ outletId: 'whatsonstage', criticName: 'Alex Wood', url, fullText: 'body', contentTier: 'complete' }));
  // a wrong-production file sharing a DIFFERENT url — must never be a merge target
  fs.writeFileSync(path.join(dir, 'whatsonstage--matt-trueman.json'),
    JSON.stringify({ outletId: 'whatsonstage', criticName: 'Matt Trueman', url: 'https://www.whatsonstage.com/news/other-production_9999/', wrongProduction: true }));
  // Aggregator roundup URL legitimately shared across outlets: a Telegraph
  // star-stub whose url IS a Show-Score roundup page. A Guardian scrape at the
  // same roundup url must NOT merge into it (distinct outlets, distinct scores).
  fs.writeFileSync(path.join(dir, 'telegraph--dominic-cavendish.json'),
    JSON.stringify({ outletId: 'telegraph', criticName: 'Dominic Cavendish', url: 'https://www.show-score.com/off-broadway-shows/roundup-xyz', aggregatorStars: '4/5' }));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('URL match: a different byline on the SAME url merges into the existing file', () => {
  const res = findExistingReviewFile(dir, 'whatsonstage', 'Alun Hood',
    'https://www.whatsonstage.com/news/a-midsummer-nights-dream-review_1726521/?utm=x');
  assert.ok(res, 'should find the existing same-URL file');
  assert.equal(res.filename, 'whatsonstage--alex-wood.json');
});

test('no URL provided: falls through to criticName behavior (different critic = no match)', () => {
  const res = findExistingReviewFile(dir, 'whatsonstage', 'Alun Hood');
  assert.equal(res, null, 'different critic, no URL → treated as a new review');
});

test('different URL: no URL match, and different critic → no match', () => {
  const res = findExistingReviewFile(dir, 'whatsonstage', 'Alun Hood', 'https://www.whatsonstage.com/news/unrelated_1/');
  assert.equal(res, null);
});

test('same critic still matches without URL (existing behavior preserved)', () => {
  const res = findExistingReviewFile(dir, 'whatsonstage', 'Alex Wood');
  assert.ok(res);
  assert.equal(res.filename, 'whatsonstage--alex-wood.json');
});

test('never merges into a wrongProduction file even if URL matched', () => {
  const res = findExistingReviewFile(dir, 'whatsonstage', 'Matt Trueman',
    'https://www.whatsonstage.com/news/other-production_9999/');
  assert.equal(res, null, 'wrongProduction file must not be a merge target');
});

test('same roundup URL, DIFFERENT outlet: does NOT merge (aggregator many-to-one)', () => {
  // A Guardian scrape at a Show-Score roundup URL that a Telegraph stub also uses
  // must not collapse into the Telegraph file — distinct outlets, distinct scores.
  const res = findExistingReviewFile(dir, 'guardian', 'Arifa Akbar',
    'https://www.show-score.com/off-broadway-shows/roundup-xyz');
  assert.equal(res, null, 'cross-outlet shared roundup URL must not merge');
});

// Adversarial review 2026-09-24 (P1-a): after a Theatre Record Unknown→Alice
// merge the file keeps its "--unknown" filename. A filename-slug match must be
// revalidated against the STORED byline, or Bob at the same outlet merges into
// Alice's review.
test('stale "--unknown" filename holding a named critic is not a merge target for a DIFFERENT critic', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-stale-unk-'));
  try {
    fs.writeFileSync(path.join(d, 'british-theatre--unknown.json'),
      JSON.stringify({ outletId: 'british-theatre', criticName: 'Alice Smith', url: 'https://www.britishtheatreguide.info/reviews/x-1', fullText: 'body' }));
    assert.equal(findExistingReviewFile(d, 'british-theatre', 'Bob Jones'), null, 'Bob must not merge into Alice');
    const same = findExistingReviewFile(d, 'british-theatre', 'Alice Smith');
    assert.ok(same, 'the same critic still finds it');
    assert.equal(same.filename, 'british-theatre--unknown.json');
    // An unattributed incoming write keeps the legacy filename-match behaviour.
    assert.ok(findExistingReviewFile(d, 'british-theatre', 'Unknown'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
