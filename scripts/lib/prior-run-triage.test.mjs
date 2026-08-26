import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyPriorRunCandidate,
  canonicalizeVenue,
  fullTextMentionsVenue,
} = require('./prior-run-triage.js');

const SHOW = { id: 'kanpur-1857-off-west-end-2026', venue: 'Theatre Royal Stratford East' };

test('classifyPriorRunCandidate: no reviews -> needs-human-review, empty stats', () => {
  const result = classifyPriorRunCandidate(SHOW, []);
  assert.equal(result.verdict, 'needs-human-review');
  assert.equal(result.stats.count, 0);
  assert.equal(result.suggestedPriorRun, null);
});

test('classifyPriorRunCandidate: majority already wrongProduction-flagged -> likely-contamination', () => {
  const reviews = [
    { publishDate: '2023-04-15', wrongProduction: true },
    { publishDate: '2023-04-15', wrongProduction: true },
    { publishDate: '2011-11-17', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate({ id: 'x', venue: 'TBA' }, reviews);
  assert.equal(result.verdict, 'likely-contamination');
  assert.equal(result.suggestedPriorRun, null);
  assert.equal(result.stats.flaggedCount, 2);
});

test('classifyPriorRunCandidate: tight single-year cluster, unflagged -> likely-single-prior-run', () => {
  const reviews = [
    { publishDate: '2025-08-01', outletId: 'guardian', wrongProduction: false },
    { publishDate: '2025-08-04', outletId: 'the-scotsman', wrongProduction: false },
    { publishDate: '2025-08-09', outletId: 'thestage', wrongProduction: false },
    { publishDate: '2025-08-18', outletId: 'times-uk', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.equal(result.verdict, 'likely-single-prior-run');
  assert.ok(result.suggestedPriorRun);
  assert.equal(result.suggestedPriorRun.venue, 'Theatre Royal Stratford East');
  assert.equal(result.suggestedPriorRun.reviewDateRangeStart, '2025-08-01');
  assert.equal(result.suggestedPriorRun.reviewDateRangeEnd, '2025-08-18');
});

test('classifyPriorRunCandidate: single review whose text mentions the show venue -> venue signal counted', () => {
  const reviews = [{
    publishDate: '2024-09-25',
    outletId: 'theater-scene',
    wrongProduction: false,
    fullText: 'Staged at the Theatre at St. Jean\'s, this revival of Monte Cristo...',
  }];
  const show = { id: 'monte-cristo-off-broadway-2026', venue: "Theatre at St. Jean's" };
  const result = classifyPriorRunCandidate(show, reviews);
  assert.equal(result.verdict, 'likely-single-prior-run');
  assert.equal(result.stats.venueMentionCount, 1);
});

test('classifyPriorRunCandidate: reviews spanning multiple distinct years -> needs-human-review', () => {
  const reviews = [
    { publishDate: '2018-03-01', wrongProduction: false },
    { publishDate: '2022-06-15', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.equal(result.verdict, 'needs-human-review');
  assert.equal(result.suggestedPriorRun, null);
  assert.equal(result.stats.distinctYears.length, 2);
});

test('classifyPriorRunCandidate: a single flagged file out of two must NOT alone trigger contamination (flaggedCount floor)', () => {
  const reviews = [
    { publishDate: '2025-01-01', wrongProduction: true },
    { publishDate: '2025-01-10', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.notEqual(result.verdict, 'likely-contamination');
});

test('classifyPriorRunCandidate: a lone review with no venue corroboration is too weak to call a prior run', () => {
  const reviews = [{ publishDate: '2018-03-01', outletId: 'guardian', wrongProduction: false, fullText: 'no venue mention here' }];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.equal(result.verdict, 'needs-human-review');
  assert.equal(result.suggestedPriorRun, null);
});

test('classifyPriorRunCandidate: a span crossing a Dec/Jan calendar-year boundary within 120 days still reads as a single run', () => {
  const reviews = [
    { publishDate: '2025-12-10', outletId: 'guardian', wrongProduction: false },
    { publishDate: '2026-01-15', outletId: 'thestage', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.equal(result.verdict, 'likely-single-prior-run');
  assert.equal(result.stats.distinctYears.length, 2);
});

test('classifyPriorRunCandidate: single year but wide span exceeds single-run window -> needs-human-review', () => {
  const reviews = [
    { publishDate: '2020-01-05', wrongProduction: false },
    { publishDate: '2020-11-20', wrongProduction: false },
  ];
  const result = classifyPriorRunCandidate(SHOW, reviews);
  assert.equal(result.verdict, 'needs-human-review');
});

test('canonicalizeVenue: strips theatre/theater/the and punctuation for loose matching', () => {
  assert.equal(canonicalizeVenue('The Ambassadors Theatre'), 'ambassadors');
  assert.equal(canonicalizeVenue('Park Theater'), 'park');
});

test('fullTextMentionsVenue: matches canonicalized substring, false on empty venue', () => {
  assert.equal(fullTextMentionsVenue('A hit at the Almeida Theatre this week.', 'Almeida Theatre'), true);
  assert.equal(fullTextMentionsVenue('A hit downtown.', 'Almeida Theatre'), false);
  assert.equal(fullTextMentionsVenue('anything', ''), false);
});

test('fullTextMentionsVenue: rejects a canonicalized venue too short to trust (avoids common-word collisions)', () => {
  // "Park Theatre" canonicalizes to "park" (4 chars) — too short to trust;
  // would otherwise false-match unrelated prose like "in the park".
  assert.equal(fullTextMentionsVenue('A show set in the park.', 'Park Theatre'), false);
});

test('canonicalizeVenue: folds diacritics so accented and unaccented spellings match', () => {
  assert.equal(canonicalizeVenue('Café de Paris Theatre'), 'cafe de paris');
  assert.equal(canonicalizeVenue('Cafe de Paris Theatre'), 'cafe de paris');
});

test('fullTextMentionsVenue: matches across the accent boundary in both directions', () => {
  assert.equal(fullTextMentionsVenue('A hit at the Café de Paris this week.', 'Cafe de Paris'), true);
  assert.equal(fullTextMentionsVenue('A hit at the Cafe de Paris this week.', 'Café de Paris'), true);
});
