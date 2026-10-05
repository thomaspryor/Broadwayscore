import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization.js');

// BRO-2274: Pass 0 of findExistingReviewFile merges on (outlet, canonical URL)
// with NO critic comparison. Corpus audit (45,791 files, 2026-10-05) found 154
// same-outlet/same-URL groups carrying two different named critics (nytimes
// Brantley+Isherwood, guardian Soloski+Hassenger on one URL, ...). One URL is
// one article, so at least one byline in each group is wrong; unlike the
// gather-reviews Proof incident (BRO-730) nothing real is lost by merging, and
// a critic guard here would recreate the byline-explosion Pass 0 exists to
// stop. This test pins that decision and the boundaries that keep it safe.
let dir;
const URL1 = 'https://www.nytimes.com/2014/04/18/theater/act-one-review.html';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-pass0-'));
  const w = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  w('nytimes--ben-brantley.json', { outletId: 'nytimes', criticName: 'Ben Brantley', url: URL1, fullText: 'body' });
  w('ap--michael-kuchwara.json', { outletId: 'ap', criticName: 'Michael Kuchwara', url: 'http://abcnews.go.com/Entertainment/wireStory?id=9327077', fullText: 'a' });
  w('guardian--jane-doe.json', { outletId: 'guardian', criticName: 'Jane Doe', url: 'https://x.com/r', wrongProduction: true });
  w('guardian--flagged-dup.json', { outletId: 'guardian', criticName: 'Dup', url: 'https://x.com/d', duplicateOf: 'guardian--jane-doe.json' });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('same outlet + same canonical URL, different named critic: merges into existing (by design)', () => {
  const res = findExistingReviewFile(dir, 'nytimes', 'Charles Isherwood', URL1 + '?utm=1#c');
  assert.equal(res?.filename, 'nytimes--ben-brantley.json');
});

test('same URL on a DIFFERENT outlet never merges (shared roundup URLs)', () => {
  const res = findExistingReviewFile(dir, 'variety', 'Ben Brantley', URL1);
  assert.equal(res, null);
});

test('same outlet, different URL, different named critic: stays separate', () => {
  const res = findExistingReviewFile(dir, 'nytimes', 'Charles Isherwood', 'https://www.nytimes.com/2014/04/19/theater/other.html');
  assert.equal(res, null);
});

test('wrongProduction / duplicateOf files are never Pass 0 merge targets', () => {
  assert.equal(findExistingReviewFile(dir, 'guardian', 'Someone Else', 'https://x.com/r'), null);
  assert.equal(findExistingReviewFile(dir, 'guardian', 'Someone Else', 'https://x.com/d'), null);
});

test('query-ID hosts: different ?id= are different articles (no merge); same id + tracking params merges', () => {
  assert.equal(findExistingReviewFile(dir, 'ap', 'Jocelyn Noveck', 'http://abcnews.go.com/Entertainment/wireStory?id=11302213'), null);
  const same = findExistingReviewFile(dir, 'ap', 'Someone', 'http://abcnews.go.com/Entertainment/wireStory?utm_source=x&id=9327077');
  assert.equal(same?.filename, 'ap--michael-kuchwara.json');
});
