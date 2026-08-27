/**
 * Regression test for gather-reviews.js's production-verification guards
 * (scripts/lib/production-verifier.js), using the exact scenario from
 * BRO-749: The Boy at the Back of the Class West End (QEH Southbank,
 * Apr 7-12 2026) had 7 collected reviews that all turned out to be the
 * same touring production's Feb 2024 Rose Theatre Kingston run, surfaced
 * via Show Score's West End page. Requires the real functions rather than
 * re-implementing the date/venue logic (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickDateCheck, verifyProduction, getShowData } from './lib/production-verifier.js';

const SHOW_ID = 'the-boy-at-the-back-of-the-class-west-end-2026';

test('quickDateCheck rejects the real Rose Theatre Kingston (Feb 2024) reviews for the QEH run', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show, `expected ${SHOW_ID} to exist in data/shows.json`);
  assert.equal(show.openingDate, '2026-04-07');

  // Actual publishDate strings from the 7 wrongProduction-flagged review-text
  // files in the private review-texts repo (all Feb 2024 Rose Theatre Kingston).
  const wrongProductionDates = [
    'February 9th, 2024',
    'February 11th, 2024',
    'February 8th, 2024',
    'February 13th, 2024',
  ];
  for (const publishDate of wrongProductionDates) {
    assert.equal(
      quickDateCheck(SHOW_ID, null, publishDate, show.openingDate),
      false,
      `expected ${publishDate} to be rejected as more than 30 days before opening (${show.openingDate})`
    );
  }
});

test('quickDateCheck accepts a review published during the actual QEH run window', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  // The genuine QEH Southbank review (londonwithatoddler.com, BRO-749 manual
  // ingest) was published on opening day of the run itself.
  assert.equal(quickDateCheck(SHOW_ID, null, '2026-04-07', show.openingDate), true);

  // A review published shortly after the run closed (Apr 12) should still
  // pass — reviewers often publish a few days after attending.
  assert.equal(quickDateCheck(SHOW_ID, null, '2026-04-17', show.openingDate), true);
});

test('verifyProduction flags a London venue mention in a US-market show without transfer context', () => {
  // A registered West End venue name appearing in a Broadway/off-Broadway
  // review with no "transferred from" / "originated at" framing is a strong
  // wrong-production signal — this is the venue-side counterpart to
  // quickDateCheck's date-range guard.
  const result = verifyProduction({
    showId: 'some-broadway-show-2026',
    url: 'https://example.com/review',
    publishDate: '2026-04-17',
    text: 'This new production plays the National Theatre through the end of the month.',
    showData: { venue: 'Some Broadway Theatre' },
    category: 'broadway',
  });
  assert.equal(result.shouldReject, true);
  assert.ok(result.issues.some((i) => i.type === 'london_venue_in_us_show'));
});

test('verifyProduction does not reject a London venue mention for a West End show itself', () => {
  // For WE/off-WE shows, a registered West End venue mention is expected, not
  // a red flag — the date-range check (quickDateCheck) is what actually
  // protects WE shows from cross-venue tour contamination, not this
  // venue-text heuristic. Uses "National Theatre" (a real WEST_END_VENUES
  // entry) rather than "Queen Elizabeth Hall" (not in that list) so this
  // genuinely exercises the WE/US branch rather than short-circuiting on an
  // empty issues list for an unrelated reason.
  const result = verifyProduction({
    showId: SHOW_ID,
    url: 'https://example.com/review',
    publishDate: '2026-04-07',
    text: 'The Boy at the Back of the Class plays the National Theatre from 7 to 12 April.',
    showData: { venue: 'Queen Elizabeth Hall - Southbank Centre' },
    category: 'west-end',
  });
  assert.equal(result.shouldReject, false);
  assert.ok(result.issues.some((i) => i.type === 'london_venue'));
});
