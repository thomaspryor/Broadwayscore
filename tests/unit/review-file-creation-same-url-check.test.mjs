// BRO-730: Review file creation should check same-URL across critic names.
//
// Root cause: createReviewFile() only merged same-URL writes into an existing
// file when BOTH names matched (or one was Unknown/a prefix of the other) —
// two DIFFERENT named critics at the same outlet sharing a URL always fell
// through to a brand-new file (Becky Shaw 2026-04: variety--brent-lang.json
// from a BWW roundup + variety--rebecca-rubin.json from a later discovery,
// same URL, same review, different critic attribution).
//
// Fix: when the EXISTING file's critic attribution came ONLY from
// roundup/positional-attribution sources (ROUNDUP_URL_SOURCES — known to
// misattribute bylines) and the INCOMING write carries a byline from a source
// this codebase already trusts for critic identity (isVerifiedDiscoverySource,
// scripts/lib/review-guards.js — NOT simply "not a roundup source"; see the
// dedicated regression test below for why that distinction matters), correct
// the existing file's criticName instead of creating a duplicate. The
// pre-existing Proof/Torre-Suskin guard (two real critics coincidentally
// sharing a URL) still applies whenever that authority signal is absent, and
// the correction itself never touches a flagged (wrongShow/wrongProduction/
// human-reviewed), manually-named, or filename-colliding file.

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

// This test runs FIRST, deliberately: createReviewFile() lazily builds a
// module-level, process-wide cache (getGlobalUrlIndex) on its first call by
// scanning the real data/review-texts/ tree, and never invalidates it. Every
// other test below creates/deletes files under this same SHOW_ID, which would
// leave that cache holding stale entries by the time this test ran — masking
// the exact "duplicate" detection this test depends on. Running first means
// the cache is built fresh, from real on-disk state, matching what a real
// single-show gather-reviews.js invocation sees.
test('correction refuses to clobber a pre-existing file already at the target filename', () => {
  // A file's on-disk criticName field can drift from its filename slug (a
  // historical manual edit, or a legacy file predating some normalization
  // change) — filenames are only ever ASSIGNED via
  // generateReviewFilename(outlet, criticName), but nothing enforces they stay
  // in sync afterward. That drift is exactly what makes the rename-onto-target
  // clobber reachable: a file whose *filename* is already
  // "variety--rebecca-rubin.json" but whose *criticName field* is something
  // else looks, to this loop, like a stray file that happens to occupy the
  // correction's rename destination.
  withTempShowDir(() => {
    const sharedUrl = urlFor(7);
    const otherUrl = urlFor(70);
    writeExisting('variety--brent-lang.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Brent Lang',
      url: sharedUrl,
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      contentTier: 'excerpt',
    });
    // Already occupies the exact filename the incoming critic would resolve
    // to, but its own criticName field has drifted from that filename.
    writeExisting('variety--rebecca-rubin.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Old Placeholder Byline',
      url: otherUrl,
      source: 'serp-discovery',
      sources: ['serp-discovery'],
      fullText: 'A genuinely different, unrelated review that happens to live at this filename.',
      contentTier: 'complete',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Rebecca Rubin',
      url: sharedUrl,
      source: 'serp-discovery',
    });

    assert.equal(result, 'duplicate', 'the global URL index already knows brent-lang.json owns this url — no write is attempted at all');
    const preExisting = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--rebecca-rubin.json'), 'utf-8'));
    assert.equal(preExisting.url, otherUrl, 'the pre-existing file at the target filename was not clobbered by the rename');
    assert.equal(preExisting.fullText, 'A genuinely different, unrelated review that happens to live at this filename.');
    const original = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--brent-lang.json'), 'utf-8'));
    assert.equal(original.criticName, 'Brent Lang', 'the roundup file was not corrected in place either, since the correction was refused wholesale');
  });
});

test('roundup-only misattribution: incoming byline from a verified discovery source corrects the existing file, no duplicate', () => {
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
      source: 'serp-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles();
    assert.deepEqual(files, ['variety--rebecca-rubin.json'], 'the roundup file was corrected+renamed, not duplicated');

    const corrected = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--rebecca-rubin.json'), 'utf-8'));
    assert.equal(corrected.criticName, 'Rebecca Rubin');
    assert.equal(corrected.url, url);
    assert.equal(corrected.source, 'serp-discovery', 'primary source updated to the verified attribution, not left as bww-roundup');
    assert.ok(corrected.sources.includes('bww-roundup') && corrected.sources.includes('serp-discovery'));
    assert.equal(corrected._criticCorrection.fromCriticName, 'Brent Lang');
    assert.equal(corrected._criticCorrection.toCriticName, 'Rebecca Rubin');
  });
});

test('RSS discovery does NOT count as a verified byline source — stays separate, not corrected', () => {
  // Regression for an adversarial ship-check finding on this same fix: an
  // earlier version used "not a roundup source" as the trust signal, which
  // wrongly treated 'rss-discovery' as authoritative. This codebase's own
  // canonical classifier (isVerifiedDiscoverySource, review-guards.js) already
  // excludes it — "RSS hits often duplicate named-critic files" — because an
  // RSS <author> is often the publication or a wire byline, not the critic.
  withTempShowDir(() => {
    const url = urlFor(5);
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
      source: 'rss-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--brent-lang.json', 'variety--rebecca-rubin.json'], 'an unverified source never corrects an existing file, even when the existing one is roundup-only');
    const original = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--brent-lang.json'), 'utf-8'));
    assert.equal(original.criticName, 'Brent Lang', 'the roundup file is untouched');
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

test('two already-authoritative critics sharing a URL stay separate (Proof/Torre-Suskin guard unaffected)', () => {
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
      source: 'direct-url-construction',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--michael-sommers.json', 'variety--tulis-mcginty.json'], 'the existing file was never roundup-only, so no correction is attempted even though the incoming source is verified');
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
      source: 'serp-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--brent-lang.json', 'variety--rebecca-rubin.json'], 'manual criticName override is respected, not silently corrected');
  });
});

test('a wrongShow-flagged existing file is never silently rebranded under the incoming critic', () => {
  withTempShowDir(() => {
    const url = urlFor(6);
    writeExisting('variety--brent-lang.json', {
      showId: SHOW_ID,
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Brent Lang',
      url,
      source: 'bww-roundup',
      sources: ['bww-roundup'],
      contentTier: 'invalid',
      wrongShow: true,
      wrongShowReason: 'Manual review: this roundup entry is about a different show',
    });

    const result = createReviewFile(SHOW_ID, {
      outletId: 'variety',
      outlet: 'Variety',
      criticName: 'Rebecca Rubin',
      url,
      source: 'serp-discovery',
    });

    assert.equal(result, true);
    const files = readAllFiles().sort();
    assert.deepEqual(files, ['variety--brent-lang.json', 'variety--rebecca-rubin.json'], 'a flagged file must not be corrected+resurrected under a new critic name');
    const original = JSON.parse(fs.readFileSync(path.join(showDir, 'variety--brent-lang.json'), 'utf-8'));
    assert.equal(original.wrongShow, true, 'the wrongShow flag survives untouched');
  });
});
