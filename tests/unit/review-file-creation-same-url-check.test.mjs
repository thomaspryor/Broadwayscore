// BRO-730: Review file creation should check same-URL across critic names.
//
// Root cause: createReviewFile() only merged same-URL writes into an existing
// file when BOTH names matched (or one was Unknown/a prefix of the other) —
// two DIFFERENT named critics at the same outlet sharing a URL always fell
// through to a brand-new file (Becky Shaw 2026-04: variety--brent-lang.json
// from a BWW roundup + variety--rebecca-rubin.json from RSS discovery, same
// URL, same review, different critic attribution).
//
// Fix: when the EXISTING file's critic attribution came ONLY from
// roundup/positional-attribution sources (ROUNDUP_URL_SOURCES — known to
// misattribute bylines) and the INCOMING write carries a byline from a more
// authoritative (non-roundup) source, correct the existing file's criticName
// instead of creating a duplicate. The pre-existing Proof/Torre-Suskin guard
// (two real critics coincidentally sharing a URL) still applies whenever
// that authority signal is absent — those stay as separate files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReviewFile } = require('../../scripts/gather-reviews.js');

const REVIEW_TEXTS_DIR = path.join(process.cwd(), 'data', 'review-texts');
// process.pid-suffixed so parallel test runs / sessions never collide on the
// same real data/review-texts/ directory (same pattern as
// gather-reviews-createreviewfile-preserves-exclusion-flags.test.mjs).
const SHOW_ID = `__test-bro730-same-url-${process.pid}`;
const showDir = path.join(REVIEW_TEXTS_DIR, SHOW_ID);
// Each test uses its OWN url — createReviewFile() maintains a process-wide,
// real-filesystem-backed global URL index (getGlobalUrlIndex) that persists
// across tests in this same file; reusing one url across tests would trip
// its "URL already indexed" same-show dupe guard before ever reaching the
// logic under test.
const urlFor = (n) => `https://variety.com/2026/legit/reviews/becky-shaw-review-example-${n}/`;

function withTempShowDir(fn) {
  fs.mkdirSync(showDir, { recursive: true });
  try {
    return fn();
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
}

function writeExisting(filename, data) {
  fs.writeFileSync(path.join(showDir, filename), JSON.stringify(data, null, 2));
}

function readAllFiles() {
  return fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
}

test('roundup-only misattribution: incoming byline from a more authoritative source corrects the existing file, no duplicate', () => {
  withTempShowDir(() => {
    const url = urlFor(1);
    writeExisting('variety--brent-lang.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Brent Lang',
      url,
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      bwwExcerpt: 'A roundup-attributed excerpt.',
      contentTier: 'excerpt',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Rebecca Rubin',
      url,
      source: 'rss-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles();
    assert.deepEqual(files, ['variety--rebecca-rubin.json'], 'the roundup file was corrected+renamed, not duplicated');

    const corrected = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--rebecca-rubin.json'), 'utf-8'));
    assert.equal(corrected.criticName, 'Rebecca Rubin');
    assert.equal(corrected.url, url);
    assert.ok(corrected.sources.includes('bww-roundup') && corrected.sources.includes('rss-discovery'));
  });
});

test('two roundup-sourced attributions at the same URL stay separate (ambiguous — neither side is authoritative)', () => {
  withTempShowDir(() => {
    const url = urlFor(2);
    writeExisting('variety--brent-lang.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Brent Lang',
      url,
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      contentTier: 'excerpt',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Rebecca Rubin',
      url,
      source: 'lbo-roundup',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--brent-lang.json', 'variety--rebecca-rubin.json'], 'both roundup sources are equally unreliable — kept separate, not merged blind');
  });
});

test('two authoritative (non-roundup) critics sharing a URL stay separate (Proof/Torre-Suskin guard unaffected)', () => {
  withTempShowDir(() => {
    const url = urlFor(3);
    writeExisting('variety--tulis-mcginty.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Tulis McGinty',
      url,
      source: 'serp-discovery',
      sources: ['serp-discovery'],
      contentTier: 'excerpt',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Michael Sommers',
      url,
      source: 'rss-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--michael-sommers.json', 'variety--tulis-mcginty.json'], 'both attributions are already authoritative — neither is corrected onto the other');
  });
});

test('a human-set criticName (criticNameManual) is never overwritten even when the source looks correctable', () => {
  withTempShowDir(() => {
    const url = urlFor(4);
    writeExisting('variety--brent-lang.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Brent Lang',
      criticNameManual: true,
      url,
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      contentTier: 'excerpt',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Rebecca Rubin',
      url,
      source: 'rss-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--brent-lang.json', 'variety--rebecca-rubin.json'], 'manual criticName override is respected, not silently corrected');
  });
});
