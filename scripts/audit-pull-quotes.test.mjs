import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { fileForReview, loadShowTexts, findBadPullQuotes } = require('./audit-pull-quotes.js');

function writeShowTexts(dir, showId, files) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [filename, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, filename), JSON.stringify(data));
  }
}

function withTmpReviewTextsDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pull-quotes-test-'));
  try {
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// BRO-180: hamlet-off-broadway-2026/nytg had two review-text files both
// stamped data.criticName === "Austin Fimmano" — one for the BAM Hamlet this
// reviews.json record is actually for, one a leftover from an earlier
// (differently-bylined) Eddie Izzard Hamlet review that was later
// re-attributed to the same critic without renaming the file. The loose
// outletId+criticName scan can't tell them apart and picked whichever
// sorted first, regardless of which review it was actually for.
test('fileForReview picks the file whose name matches outlet+critic exactly over a same-criticName decoy', () => {
  withTmpReviewTextsDir((tmp) => {
    writeShowTexts(tmp, 'hamlet-off-broadway-2026', {
      // Sorts first alphabetically — the file the old loose scan would
      // wrongly return since it also carries criticName "Austin Fimmano".
      'nytg--amelia-merrill.json': {
        outletId: 'nytg',
        criticName: 'Austin Fimmano',
        url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-eddie-izzard',
        fullText: 'wrong production entirely',
      },
      'nytg--austin-fimmano.json': {
        outletId: 'nytg',
        criticName: 'Austin Fimmano',
        url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-bam',
        fullText: 'the correct BAM production review',
      },
    });
    const texts = loadShowTexts('hamlet-off-broadway-2026', tmp);
    const r = {
      showId: 'hamlet-off-broadway-2026', outletId: 'nytg', criticName: 'Austin Fimmano',
      url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-bam',
    };
    const entry = fileForReview(texts, r);
    assert.equal(entry.file, 'nytg--austin-fimmano.json');
    assert.equal(entry.data.url, r.url);
  });
});

// pride-west-end-2026/standard shape: three files share the exact same URL
// AND two of them share data.criticName "Nick Curtis" (a byline correction
// rewrote the JSON's criticName field on one file without renaming it).
// Neither URL nor the loose criticName scan disambiguates; only the
// filename — generated at write time from outlet+critic and never renamed —
// does.
test('fileForReview resolves a same-url, same-criticName-metadata collision via the exact filename', () => {
  withTmpReviewTextsDir((tmp) => {
    const sharedUrl = 'https://www.standard.co.uk/culture/theatre/pride-review.html';
    writeShowTexts(tmp, 'pride-west-end-2026', {
      // Sorts first — a decoy file whose internal criticName field was
      // overwritten by a later correction but whose filename was not.
      'standard--ghenet-pinderhughes-randall.json': {
        outletId: 'standard', criticName: 'Nick Curtis', url: sharedUrl, fullText: 'shorter, decoy scrape',
      },
      'standard--nick-curtis.json': {
        outletId: 'standard', criticName: 'Nick Curtis', url: sharedUrl, fullText: 'the real, correct scrape',
      },
    });
    const texts = loadShowTexts('pride-west-end-2026', tmp);
    const r = { showId: 'pride-west-end-2026', outletId: 'standard', criticName: 'Nick Curtis', url: sharedUrl };
    const entry = fileForReview(texts, r);
    assert.equal(entry.file, 'standard--nick-curtis.json');
    assert.equal(entry.data.fullText, 'the real, correct scrape');
  });
});

// A file matches by exact filename, but it's flagged wrongProduction/
// duplicateOf — it must never win. Mirrors findExistingReviewFile()'s own
// exclusion rule in scripts/lib/review-normalization.js: a flagged file is
// never a valid match target, so the real (unflagged, URL-unique) file must
// be preferred even though its own filename doesn't match r.criticName.
test('fileForReview skips a wrongProduction/duplicateOf file even when its filename matches exactly', () => {
  withTmpReviewTextsDir((tmp) => {
    writeShowTexts(tmp, 'some-show-2026', {
      'outlet--jane-critic.json': {
        outletId: 'outlet', criticName: 'Jane Critic', url: 'https://example.com/wrong-production',
        wrongProduction: true, fullText: 'flagged — must not be returned',
      },
      'outlet--j-critic.json': {
        outletId: 'outlet', criticName: 'Jane Critic', url: 'https://example.com/the-real-review',
        fullText: 'the real review',
      },
    });
    const texts = loadShowTexts('some-show-2026', tmp);
    const r = { showId: 'some-show-2026', outletId: 'outlet', criticName: 'Jane Critic', url: 'https://example.com/the-real-review' };
    const entry = fileForReview(texts, r);
    assert.equal(entry.file, 'outlet--j-critic.json');
  });
});

// an-american-daughter-off-broadway-2026/pages-on-stages shape: the review
// was originally scraped byline-less ("--unknown.json", real content, real
// URL). A later criticName backfill wrote "Mason Pilevsky" onto the
// reviews.json record but produced an empty STUB file at the name an
// exact-filename match would expect ("--mason-pilevsky.json", url: null, no
// text) instead of renaming the original. Filename-first alone would silently
// prefer the empty stub over the real content; the unambiguous-URL pass must
// win here.
test('fileForReview prefers the unambiguous URL match over an empty same-name stub', () => {
  withTmpReviewTextsDir((tmp) => {
    writeShowTexts(tmp, 'an-american-daughter-off-broadway-2026', {
      'pages-on-stages--unknown.json': {
        outletId: 'pages-on-stages', criticName: 'Unknown',
        url: 'https://pagesonstages.com/2026/08/11/an-american-daughter/',
        fullText: 'the real, full review text',
      },
      'pages-on-stages--mason-pilevsky.json': {
        outletId: 'pages-on-stages', criticName: 'Mason Pilevsky', url: null, fullText: '',
      },
    });
    const texts = loadShowTexts('an-american-daughter-off-broadway-2026', tmp);
    const r = {
      showId: 'an-american-daughter-off-broadway-2026', outletId: 'pages-on-stages', criticName: 'Mason Pilevsky',
      url: 'https://pagesonstages.com/2026/08/11/an-american-daughter/',
    };
    const entry = fileForReview(texts, r);
    assert.equal(entry.file, 'pages-on-stages--unknown.json');
    assert.equal(entry.data.fullText, 'the real, full review text');
  });
});

// No file matches the exact outlet+critic filename (legacy naming, or the
// critic's byline normalizes differently than it did at write time) — must
// still fall back to the old loose outletId+criticName scan rather than
// return nothing.
test('fileForReview falls back to the loose outletId+criticName scan when no exact filename exists', () => {
  withTmpReviewTextsDir((tmp) => {
    writeShowTexts(tmp, 'some-show-2026', {
      'outlet--legacy-name-format.json': {
        outletId: 'outlet', criticName: 'Jane Critic', url: 'https://example.com/review', fullText: 'legacy file',
      },
    });
    const texts = loadShowTexts('some-show-2026', tmp);
    const r = { showId: 'some-show-2026', outletId: 'outlet', criticName: 'Jane Critic', url: 'https://example.com/review' };
    const entry = fileForReview(texts, r);
    assert.equal(entry.file, 'outlet--legacy-name-format.json');
  });
});

// End-to-end: findBadPullQuotes uses fileForReview internally to source the
// evidence text for the mid-word-truncation check. Prove the fix flows
// through by feeding it the same decoy-file shape and confirming it reads
// the correct file's content, not the decoy's.
test('findBadPullQuotes reads the correct file\'s text through the outlet+critic collision', () => {
  withTmpReviewTextsDir((tmp) => {
    writeShowTexts(tmp, 'hamlet-off-broadway-2026', {
      'nytg--amelia-merrill.json': {
        outletId: 'nytg', criticName: 'Austin Fimmano',
        url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-eddie-izzard',
        fullText: 'a decoy full text that shares no words with the shipped quote',
      },
      'nytg--austin-fimmano.json': {
        outletId: 'nytg', criticName: 'Austin Fimmano',
        url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-bam',
        fullText: 'Hiran Abeysekera pulls out a charmingly cheeky yet heartbreakingly boyish prince',
      },
    });
    const reviews = [{
      showId: 'hamlet-off-broadway-2026', outletId: 'nytg', criticName: 'Austin Fimmano',
      url: 'https://www.newyorktheatreguide.com/reviews/hamlet-off-broadway-review-bam',
      pullQuote: 'Hiran Abeysekera pulls out a charmingly cheeky yet heartbreakingly boyish prince',
    }];
    const badQuotes = findBadPullQuotes(reviews, tmp);
    assert.deepEqual(badQuotes, []);
  });
});
