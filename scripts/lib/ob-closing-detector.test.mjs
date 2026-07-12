import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractClosingDateMentions,
  resolveMentionDate,
  extractClosingDateCandidates,
  runLengthWeeks,
  aggregateClosingDateCandidates,
  updateTodayTixMissingState,
  decideTodayTixCandidates,
  shouldSuppressCandidate,
} = require('./ob-closing-detector.js');

// --- extractClosingDateMentions: date-pattern extraction ---

test('extracts "through Sun July 5" (day-of-week, no year)', () => {
  const mentions = extractClosingDateMentions('The show runs through Sun July 5 at the theater.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 7);
  assert.equal(mentions[0].day, 5);
  assert.equal(mentions[0].year, null);
});

test('extracts "through July 5, 2026" (explicit year)', () => {
  const mentions = extractClosingDateMentions('Tickets are on sale through July 5, 2026 only.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 7);
  assert.equal(mentions[0].day, 5);
  assert.equal(mentions[0].year, 2026);
});

test('extracts "runs thru 7/5" (numeric date, no year)', () => {
  const mentions = extractClosingDateMentions('The limited engagement runs thru 7/5 at Theater Row.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 7);
  assert.equal(mentions[0].day, 5);
  assert.equal(mentions[0].year, null);
});

test('extracts numeric date with 2-digit year', () => {
  const mentions = extractClosingDateMentions('Performances continue through 7/5/26.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].year, 2026);
});

test('does NOT match "through the years" (negative case)', () => {
  const mentions = extractClosingDateMentions('This show has evolved through the years into something special.');
  assert.equal(mentions.length, 0);
});

test('does NOT match bare "closes" without a trailing date', () => {
  const mentions = extractClosingDateMentions('The theater closes its doors early on weeknights.');
  assert.equal(mentions.length, 0);
});

test('extracts "closes <date>"', () => {
  const mentions = extractClosingDateMentions('The production closes August 14, 2026.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 8);
  assert.equal(mentions[0].day, 14);
  assert.equal(mentions[0].year, 2026);
});

test('extracts "final performance <date>"', () => {
  const mentions = extractClosingDateMentions('The final performance is September 1.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 9);
  assert.equal(mentions[0].day, 1);
});

test('extracts "limited run through <date>"', () => {
  const mentions = extractClosingDateMentions('This is a limited run through June 30, 2026 at the venue.');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].month, 6);
  assert.equal(mentions[0].day, 30);
  assert.equal(mentions[0].year, 2026);
});

// --- resolveMentionDate: year resolution from review context, never URLs ---

test('resolves year from publishDate when text omits it (same-year case)', () => {
  const mention = { month: 7, day: 5, year: null };
  assert.equal(resolveMentionDate(mention, '2026-06-15'), '2026-07-05');
});

test('rolls to next year when computed date is well before publishDate', () => {
  // Review published Dec 2026 says "through Jan 5" — must mean Jan 2027, not Jan 2026.
  const mention = { month: 1, day: 5, year: null };
  assert.equal(resolveMentionDate(mention, '2026-12-10'), '2027-01-05');
});

test('uses explicit year in the mention over publishDate inference', () => {
  const mention = { month: 7, day: 5, year: 2027 };
  assert.equal(resolveMentionDate(mention, '2026-06-15'), '2027-07-05');
});

test('returns null when no year in text and no publishDate available', () => {
  const mention = { month: 7, day: 5, year: null };
  assert.equal(resolveMentionDate(mention, undefined), null);
});

// --- extractClosingDateCandidates: the real Misterman FRC boilerplate ---

test('Misterman fixture: resolves full closing date from review context', () => {
  const fullText =
    "Misterman runs through Sun July 5 at Theater Row, 410 West 42nd Street. " +
    "Running Time: 90 minutes no intermission";
  const candidates = extractClosingDateCandidates(fullText, '2026-06-20');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isoDate, '2026-07-05');
  assert.match(candidates[0].quote, /runs through Sun July 5/);
});

// --- runLengthWeeks ---

test('computes run length in weeks', () => {
  assert.equal(runLengthWeeks('2026-06-01', '2026-06-15'), 2);
});

test('returns null when closing is not after opening', () => {
  assert.equal(runLengthWeeks('2026-06-15', '2026-06-01'), null);
});

// --- aggregateClosingDateCandidates: corroboration ---

test('proposes high confidence when 2+ reviews agree', () => {
  const result = aggregateClosingDateCandidates('show-1', '2026-05-01', [
    { reviewId: 'nyt/review.json', isoDate: '2026-07-05', quote: 'q1' },
    { reviewId: 'timeout/review.json', isoDate: '2026-07-05', quote: 'q2' },
  ]);
  assert.equal(result.confidence, 'high');
  assert.equal(result.proposedClosingDate, '2026-07-05');
});

test('proposes medium confidence for single review within 1-10wk run length', () => {
  const result = aggregateClosingDateCandidates('show-1', '2026-05-01', [
    { reviewId: 'nyt/review.json', isoDate: '2026-06-01', quote: 'q1' },
  ]);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.proposedClosingDate, '2026-06-01');
});

test('does not propose for single review outside 1-10wk run length', () => {
  const result = aggregateClosingDateCandidates('show-1', '2026-05-01', [
    { reviewId: 'nyt/review.json', isoDate: '2027-05-01', quote: 'q1' },
  ]);
  assert.equal(result, null);
});

test('does not propose when reviews disagree (ambiguous)', () => {
  const result = aggregateClosingDateCandidates('show-1', '2026-05-01', [
    { reviewId: 'nyt/review.json', isoDate: '2026-07-05', quote: 'q1' },
    { reviewId: 'timeout/review.json', isoDate: '2026-07-12', quote: 'q2' },
  ]);
  assert.equal(result, null);
});

test('returns null for empty mentions', () => {
  assert.equal(aggregateClosingDateCandidates('show-1', '2026-05-01', []), null);
});

// --- TodayTix staleness diff ---

test('updateTodayTixMissingState starts a new entry for a newly-missing show', () => {
  const state = updateTodayTixMissingState({}, ['show-a', 'show-b'], new Set(['show-b']), '2026-07-01');
  assert.deepEqual(state, {
    'show-a': { consecutiveMissingChecks: 1, firstMissingDate: '2026-07-01', lastCheckedDate: '2026-07-01' },
  });
});

test('updateTodayTixMissingState increments consecutive count across runs', () => {
  const week1 = updateTodayTixMissingState({}, ['show-a'], new Set(), '2026-07-01');
  const week2 = updateTodayTixMissingState(week1, ['show-a'], new Set(), '2026-07-08');
  assert.equal(week2['show-a'].consecutiveMissingChecks, 2);
  assert.equal(week2['show-a'].firstMissingDate, '2026-07-01');
  assert.equal(week2['show-a'].lastCheckedDate, '2026-07-08');
});

test('updateTodayTixMissingState resets (drops) a show that reappears', () => {
  const week1 = updateTodayTixMissingState({}, ['show-a'], new Set(), '2026-07-01');
  const week2 = updateTodayTixMissingState(week1, ['show-a'], new Set(['show-a']), '2026-07-08');
  assert.deepEqual(week2, {});
});

test('decideTodayTixCandidates only flags entries at/above the threshold', () => {
  const state = {
    'show-a': { consecutiveMissingChecks: 1, firstMissingDate: '2026-07-08' },
    'show-b': { consecutiveMissingChecks: 2, firstMissingDate: '2026-07-01' },
    'show-c': { consecutiveMissingChecks: 3, firstMissingDate: '2026-06-24' },
  };
  const candidates = decideTodayTixCandidates(state, 2);
  const ids = candidates.map((c) => c.showId).sort();
  assert.deepEqual(ids, ['show-b', 'show-c']);
});

// --- shouldSuppressCandidate (weekly-alert noise guards) ---

test('suppress: existing closingDate always wins over review boilerplate', () => {
  const show = { id: 'heathers-2025', closingDate: '2026-11-08', status: 'open' };
  assert.equal(shouldSuppressCandidate(show, '2026-01-25', '2026-07-12'), 'already-has-closing-date');
});

test('suppress: proposal more than a year past = extended/open-ended, not stale-open', () => {
  const show = { id: 'little-shop-2019', closingDate: null, status: 'open' };
  assert.equal(shouldSuppressCandidate(show, '2020-01-19', '2026-07-12'), 'stale-evidence');
});

test('suppress: recent past and future proposals on date-less shows are actionable', () => {
  const show = { id: 'my-joy-2025', closingDate: null, status: 'open' };
  assert.equal(shouldSuppressCandidate(show, '2026-04-05', '2026-07-12'), null);
  assert.equal(shouldSuppressCandidate(show, '2026-09-11', '2026-07-12'), null);
});
