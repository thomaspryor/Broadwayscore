// BRO-4154: selector for review-text files nulled by the pre-2026-09-25
// punctuation-sensitive show-mention bug. Fixtures below are copied verbatim
// (minus timestamps) from the real broadway-review-texts corpus so this test
// fails if the selector's logic drifts from the actual incident.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  titleNeedsNormalization,
  isPunctuationNulledCandidate,
  findPunctuationNulledFiles,
} from './punctuation-nulled-recollect.js';

// Real file: dog-man-the-musical-west-end-2026/theatre-weekly--unknown.json
const DOG_MAN_TITLE = 'Dog Man - The Musical';
const DOG_MAN_THEATRE_WEEKLY = {
  showId: 'dog-man-the-musical-west-end-2026',
  outletId: 'theatre-weekly',
  url: 'https://theatreweekly.com/review-dog-man-the-musical-at-queen-elizabeth-hall/',
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 4511-char text)',
  fetchDiscoveryAbandoned: true,
};

// Real file: dog-man-the-musical-west-end-2026/musical-theatre-review--unknown.json
const DOG_MAN_MUSICAL_THEATRE_REVIEW = {
  showId: 'dog-man-the-musical-west-end-2026',
  outletId: 'musical-theatre-review',
  url: 'https://musicaltheatrereview.com/dog-man-the-musical-queen-elizabeth-hall/',
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 1923-char text)',
  fetchDiscoveryAbandoned: true,
};

// Real file: glengarry-glen-ross-west-end-2026/whatsonstage--lucinda-everett.json
// Same rejection shape (url_content_mismatch, "mentioned 0x", titleMatch=true)
// but the title "Glengarry Glen Ross" has no punctuation a normalizer would
// touch — this is NOT the punctuation bug (likely a body that never repeats a
// one-word-per-token title), so it must be correctly excluded.
const GLENGARRY_TITLE = 'Glengarry Glen Ross';
const GLENGARRY_WHATSONSTAGE = {
  showId: 'glengarry-glen-ross-west-end-2026',
  outletId: 'whatsonstage',
  url: 'https://www.whatsonstage.com/news/glengarry-glen-ross-review-all-female-revival-in-the-round-at-the-old-vic_1725353/',
  fullText: null,
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 3941-char text, titleMatch=true)',
  fetchDiscoveryAbandoned: true,
};

// A file correctly flagged as the wrong production entirely — must never be
// swept into a blind re-collection regardless of title punctuation.
const WRONG_PRODUCTION_PUNCTUATED_TITLE = {
  showId: 'oh-mary-off-broadway-2026',
  outletId: 'guardian',
  url: 'https://www.theguardian.com/stage/some-other-play-review',
  contentTier: 'invalid',
  incompleteReason: 'wrong_content',
  incompleteDetail: 'Wrong production',
};

test('selects the real Dog Man examples (punctuation-sensitive title, mention-count rejection)', () => {
  const r1 = isPunctuationNulledCandidate(DOG_MAN_THEATRE_WEEKLY, DOG_MAN_TITLE);
  assert.equal(r1.candidate, true, r1.reason);
  const r2 = isPunctuationNulledCandidate(DOG_MAN_MUSICAL_THEATRE_REVIEW, DOG_MAN_TITLE);
  assert.equal(r2.candidate, true, r2.reason);
});

test('excludes Glengarry Glen Ross (same rejection shape, unpunctuated title)', () => {
  assert.equal(titleNeedsNormalization(GLENGARRY_TITLE), false);
  const r = isPunctuationNulledCandidate(GLENGARRY_WHATSONSTAGE, GLENGARRY_TITLE);
  assert.equal(r.candidate, false);
});

test('excludes a correctly-flagged wrong_content file even for a punctuated title', () => {
  const r = isPunctuationNulledCandidate(WRONG_PRODUCTION_PUNCTUATED_TITLE, 'Oh, Mary!');
  assert.equal(r.candidate, false);
  assert.match(r.reason, /wrong_content/);
});

test('excludes a file that already has usable fullText', () => {
  const data = { ...DOG_MAN_THEATRE_WEEKLY, fullText: 'x'.repeat(400) };
  const r = isPunctuationNulledCandidate(data, DOG_MAN_TITLE);
  assert.equal(r.candidate, false, r.reason);
});

test('excludes a duplicateOf / LLM-verified-wrong-article file even on a punctuated title', () => {
  const dup = { ...DOG_MAN_THEATRE_WEEKLY, duplicateOf: 'some-other-file.json' };
  assert.equal(isPunctuationNulledCandidate(dup, DOG_MAN_TITLE).candidate, false);

  const cv = { ...DOG_MAN_THEATRE_WEEKLY, contentVerification: { verifiedBy: 'llm:gemini', wrongArticle: true } };
  assert.equal(isPunctuationNulledCandidate(cv, DOG_MAN_TITLE).candidate, false);
});

// P1 found by ship-check adversarial review: wrongShow/wrongProduction booleans
// are the canonical "confirmed wrong show" signal used elsewhere in this repo
// (review-guards.js documents them existing WITHOUT wrongShowReason) and can
// sit alongside a stale incompleteReason: 'url_content_mismatch' that was
// never re-classified after the wrong-show finding landed.
test('excludes wrongShow/wrongProduction=true even when incompleteReason still says url_content_mismatch', () => {
  const wrongShow = { ...DOG_MAN_THEATRE_WEEKLY, wrongShow: true };
  assert.equal(isPunctuationNulledCandidate(wrongShow, DOG_MAN_TITLE).candidate, false);

  const wrongProduction = { ...DOG_MAN_THEATRE_WEEKLY, wrongProduction: true };
  assert.equal(isPunctuationNulledCandidate(wrongProduction, DOG_MAN_TITLE).candidate, false);

  const cvWrongProduction = {
    ...DOG_MAN_THEATRE_WEEKLY,
    contentVerification: { verifiedBy: 'llm:gemini', wrongProduction: true },
  };
  assert.equal(isPunctuationNulledCandidate(cvWrongProduction, DOG_MAN_TITLE).candidate, false);

  const cvFilmTv = {
    ...DOG_MAN_THEATRE_WEEKLY,
    contentVerification: { verifiedBy: 'llm:gemini', isFilmTv: true },
  };
  assert.equal(isPunctuationNulledCandidate(cvFilmTv, DOG_MAN_TITLE).candidate, false);
});

test('showNotMentioned/wrongFullText schema: only selects when the variant matcher actually finds the show', () => {
  const matches = {
    ...DOG_MAN_THEATRE_WEEKLY,
    incompleteReason: undefined,
    incompleteDetail: undefined,
    showNotMentioned: true,
    wrongFullText: 'A full review of Dog Man: The Musical at the Southbank Centre, with plenty of tail-wagging fun.',
  };
  const r = isPunctuationNulledCandidate(matches, DOG_MAN_TITLE);
  assert.equal(r.candidate, true, r.reason);

  const noMatch = {
    ...DOG_MAN_THEATRE_WEEKLY,
    incompleteReason: undefined,
    incompleteDetail: undefined,
    showNotMentioned: true,
    wrongFullText: 'A review of an entirely unrelated production with no connection to this title.',
  };
  const r2 = isPunctuationNulledCandidate(noMatch, DOG_MAN_TITLE);
  assert.equal(r2.candidate, false);
});

test('findPunctuationNulledFiles walks a review-texts checkout and returns only real candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro4154-rt-'));
  try {
    const dogManDir = join(dir, 'dog-man-the-musical-west-end-2026');
    mkdirSync(dogManDir);
    writeFileSync(join(dogManDir, 'theatre-weekly--unknown.json'), JSON.stringify(DOG_MAN_THEATRE_WEEKLY));
    writeFileSync(join(dogManDir, 'musical-theatre-review--unknown.json'), JSON.stringify(DOG_MAN_MUSICAL_THEATRE_REVIEW));

    const glengarryDir = join(dir, 'glengarry-glen-ross-west-end-2026');
    mkdirSync(glengarryDir);
    writeFileSync(join(glengarryDir, 'whatsonstage--lucinda-everett.json'), JSON.stringify(GLENGARRY_WHATSONSTAGE));

    // A directory with no title mapping (e.g. a show removed from shows.json) must not crash the scan.
    const orphanDir = join(dir, 'orphan-show-2026');
    mkdirSync(orphanDir);
    writeFileSync(join(orphanDir, 'outlet--critic.json'), JSON.stringify({ incompleteReason: 'url_content_mismatch' }));

    const showTitleById = {
      'dog-man-the-musical-west-end-2026': DOG_MAN_TITLE,
      'glengarry-glen-ross-west-end-2026': GLENGARRY_TITLE,
    };

    const results = findPunctuationNulledFiles(dir, showTitleById);
    const files = results.map((r) => `${r.showId}/${r.file}`).sort();
    assert.deepEqual(files, [
      'dog-man-the-musical-west-end-2026/musical-theatre-review--unknown.json',
      'dog-man-the-musical-west-end-2026/theatre-weekly--unknown.json',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
