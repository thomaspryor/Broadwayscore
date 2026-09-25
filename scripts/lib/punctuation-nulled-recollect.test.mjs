/**
 * BRO-4154: selector for review-text files nulled by the pre-fix (literal,
 * punctuation-sensitive) show-mention matcher rather than a genuine
 * wrong-show mismatch. Fixtures below are trimmed real review-texts files:
 *
 *   - dog-man-the-musical-west-end-2026/theatre-weekly--unknown.json and
 *     .../musical-theatre-review--unknown.json: both url_content_mismatch,
 *     fullText nulled, but their own URLs plainly review "Dog Man - The
 *     Musical" — punctuation-bug victims BRO-4154 exists to recover.
 *   - golden-boy-off-west-end-2026/whatsonstage--unknown.json: also
 *     url_content_mismatch with fullText nulled, but its URL
 *     ("man-and-boy-at-the-national-theatre-review") is a different play
 *     entirely — a correctly-flagged wrong-show file that must NOT be
 *     selected for recollection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isPunctuationNulledCandidate,
  findPunctuationNulledFiles,
  urlToSlugText,
} = require('./punctuation-nulled-recollect.js');

const DOG_MAN_THEATRE_WEEKLY = {
  showId: 'dog-man-the-musical-west-end-2026',
  outletId: 'theatre-weekly',
  url: 'https://theatreweekly.com/review-dog-man-the-musical-at-queen-elizabeth-hall/',
  fullText: null,
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 4511-char text)',
};

const DOG_MAN_MTR = {
  showId: 'dog-man-the-musical-west-end-2026',
  outletId: 'musical-theatre-review',
  url: 'https://musicaltheatrereview.com/dog-man-the-musical-queen-elizabeth-hall/',
  fullText: null,
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 1923-char text)',
};

const GOLDEN_BOY_WHATSONSTAGE_WRONG_SHOW = {
  showId: 'golden-boy-off-west-end-2026',
  outletId: 'whatsonstage',
  url: 'https://www.whatsonstage.com/news/man-and-boy-at-the-national-theatre-review_1711733/',
  fullText: null,
  contentTier: 'stub',
  incompleteReason: 'url_content_mismatch',
  incompleteDetail: 'show mentioned 0× (below 3 threshold for 4930-char text)',
};

const SHOW_TITLES = {
  'dog-man-the-musical-west-end-2026': 'Dog Man - The Musical',
  'golden-boy-off-west-end-2026': 'Golden Boy',
};

test('urlToSlugText turns URL path separators into spaces', () => {
  assert.equal(
    urlToSlugText('https://theatreweekly.com/review-dog-man-the-musical-at-queen-elizabeth-hall/'),
    ' review dog man the musical at queen elizabeth hall ',
  );
  assert.equal(urlToSlugText('https://example.com/dog_man/review-page/'), ' dog man review page ');
  assert.equal(urlToSlugText(''), '');
  assert.equal(urlToSlugText(null), '');
});

test('isPunctuationNulledCandidate: real BRO-4154 examples match', () => {
  assert.equal(
    isPunctuationNulledCandidate(DOG_MAN_THEATRE_WEEKLY, SHOW_TITLES['dog-man-the-musical-west-end-2026']),
    true,
  );
  assert.equal(
    isPunctuationNulledCandidate(DOG_MAN_MTR, SHOW_TITLES['dog-man-the-musical-west-end-2026']),
    true,
  );
});

test('isPunctuationNulledCandidate: correctly-flagged wrong-show file does not match', () => {
  assert.equal(
    isPunctuationNulledCandidate(GOLDEN_BOY_WHATSONSTAGE_WRONG_SHOW, SHOW_TITLES['golden-boy-off-west-end-2026']),
    false,
  );
});

test('isPunctuationNulledCandidate: text still present is out of scope even if reason matches', () => {
  const hasText = { ...DOG_MAN_THEATRE_WEEKLY, fullText: 'Dog Man - The Musical is great fun.' };
  assert.equal(isPunctuationNulledCandidate(hasText, SHOW_TITLES['dog-man-the-musical-west-end-2026']), false);
});

test('isPunctuationNulledCandidate: reason other than url_content_mismatch/showNotMentioned is out of scope', () => {
  const otherReason = { ...DOG_MAN_THEATRE_WEEKLY, incompleteReason: 'paywall' };
  assert.equal(isPunctuationNulledCandidate(otherReason, SHOW_TITLES['dog-man-the-musical-west-end-2026']), false);
});

test('isPunctuationNulledCandidate: showNotMentioned:true with a URL-matching slug also selects', () => {
  const showNotMentioned = {
    showId: 'dog-man-the-musical-west-end-2026',
    outletId: 'some-outlet',
    url: 'https://example.com/dog-man-the-musical-review/',
    fullText: null,
    showNotMentioned: true,
  };
  assert.equal(
    isPunctuationNulledCandidate(showNotMentioned, SHOW_TITLES['dog-man-the-musical-west-end-2026']),
    true,
  );
});

test('findPunctuationNulledFiles: scans a fixture tree and returns only real candidates', () => {
  const tree = {
    'dog-man-the-musical-west-end-2026': {
      'theatre-weekly--unknown.json': DOG_MAN_THEATRE_WEEKLY,
      'musical-theatre-review--unknown.json': DOG_MAN_MTR,
      'guardian--unknown.json': {
        showId: 'dog-man-the-musical-west-end-2026',
        url: 'https://guardian.com/dog-man-the-musical-review',
        fullText: 'A full review of Dog Man - The Musical...',
        contentTier: 'complete',
      },
    },
    'golden-boy-off-west-end-2026': {
      'whatsonstage--unknown.json': GOLDEN_BOY_WHATSONSTAGE_WRONG_SHOW,
    },
    _pending: {
      'some-show': { 'outlet--unknown.json': DOG_MAN_THEATRE_WEEKLY },
    },
  };

  const deps = {
    readdirSync: (dir, opts) => {
      const base = dir.split('/').pop();
      if (opts && opts.withFileTypes) {
        return Object.keys(tree).map((name) => ({
          name,
          isDirectory: () => true,
        }));
      }
      return Object.keys(tree[base] || {});
    },
    existsSync: () => true,
    readFileSync: (filePath) => {
      const parts = filePath.split('/');
      const file = parts.pop();
      const showId = parts.pop();
      return JSON.stringify(tree[showId][file]);
    },
  };

  const found = findPunctuationNulledFiles('/fake/review-texts', SHOW_TITLES, deps);
  const keys = found.map((f) => `${f.showId}/${f.file}`).sort();
  assert.deepEqual(keys, [
    'dog-man-the-musical-west-end-2026/musical-theatre-review--unknown.json',
    'dog-man-the-musical-west-end-2026/theatre-weekly--unknown.json',
  ]);
});
