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
import { createRequire } from 'module';
import { quickDateCheck, verifyProduction, getShowData } from './lib/production-verifier.js';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('./gather-reviews.js');

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

// BRO-923: NYSR (New York Stage Review) publishes 2 critics per major opening
// (typically Frank Scheck + David Finkle). When one critic's review is
// extracted via Method 1 (JSON-LD BlogPosting) and the other only surfaces in
// Method 2's articleBody-text supplement, each URL-population pass used to
// rebuild its own per-outlet anchor queue from scratch — so Method 2's pass
// handed the SECOND critic the SAME href Method 1 had already assigned the
// FIRST. Both review files landed with byte-identical URLs, and rebuild's
// URL-fingerprint dedup silently dropped one critic's review every opening
// night. Fixed by sharing one queue/index across both passes.
test('BRO-923: NYSR 2-critics-1-URL — Method 1 and Method 2 critics get distinct URLs', () => {
  const scheckUrl = 'https://nystagereview.com/2026/04/15/the-fear-of-13-prison-drama-feels-like-a-long-stretch/';
  const finkleUrl = 'https://nystagereview.com/2026/04/15/the-fear-of-13-adrien-brody-acquits-himself-as-death-row-convict/';

  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "articleBody": "Let's see what the critics had to say... David Finkle, New York Stage Review: Finkle praises the show's daring commitment to its bleak subject matter.",
  "liveBlogUpdate": [
    { "@type": "BlogPosting", "author": { "name": "New York Stage Review - Frank Scheck" }, "articleBody": "Scheck says the show feels like a long stretch behind bars." }
  ]
}
</script>
<p>Frank Scheck, <a href="${scheckUrl}">New York Stage Review:</a> Scheck says the show feels like a long stretch behind bars.</p>
<p>David Finkle, <a href="${finkleUrl}">New York Stage Review:</a> Finkle praises the show's daring commitment to its bleak subject matter.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(
    html,
    'the-fear-of-13-2026',
    'https://www.broadwayworld.com/article/test',
    'The Fear of 13'
  );

  const nysrs = reviews.filter((r) => r.outletId === 'nysr');
  assert.strictEqual(nysrs.length, 2, `expected 2 NYSR entries, got ${nysrs.length}`);

  const scheck = nysrs.find((r) => r.criticName === 'Frank Scheck');
  const finkle = nysrs.find((r) => r.criticName === 'David Finkle');
  assert.ok(scheck, 'expected a Frank Scheck NYSR entry');
  assert.ok(finkle, 'expected a David Finkle NYSR entry');

  assert.strictEqual(scheck.url, scheckUrl);
  assert.strictEqual(finkle.url, finkleUrl);
  assert.notStrictEqual(scheck.url, finkle.url,
    'Scheck and Finkle must not share a URL — that is the exact BRO-923 dedup-collapse bug');
});

test('BRO-923: NYSR — only one anchor exists, second critic gets url:null (not a duplicate)', () => {
  // BWW roundup page sometimes only links ONE of the two critics' articles.
  // The second critic must fall back to null (recoverable later via SERP/site
  // search) rather than silently inheriting the first critic's URL.
  const scheckUrl = 'https://nystagereview.com/2026/04/15/the-fear-of-13-prison-drama-feels-like-a-long-stretch/';

  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "articleBody": "Let's see what the critics had to say... David Finkle, New York Stage Review: Finkle praises the show's daring commitment to its bleak subject matter.",
  "liveBlogUpdate": [
    { "@type": "BlogPosting", "author": { "name": "New York Stage Review - Frank Scheck" }, "articleBody": "Scheck says the show feels like a long stretch behind bars." }
  ]
}
</script>
<p>Frank Scheck, <a href="${scheckUrl}">New York Stage Review:</a> Scheck says the show feels like a long stretch behind bars.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(
    html,
    'the-fear-of-13-2026',
    'https://www.broadwayworld.com/article/test',
    'The Fear of 13'
  );

  const nysrs = reviews.filter((r) => r.outletId === 'nysr');
  const scheck = nysrs.find((r) => r.criticName === 'Frank Scheck');
  const finkle = nysrs.find((r) => r.criticName === 'David Finkle');
  assert.ok(scheck, 'expected a Frank Scheck NYSR entry');
  assert.ok(finkle, 'expected a David Finkle NYSR entry');

  assert.strictEqual(scheck.url, scheckUrl);
  assert.strictEqual(finkle.url, null,
    'with only one anchor on the page, the second critic must get null, not a copy of the first critic\'s URL');
});

test('BRO-923: a rejected candidate does not donate the next critic\'s URL to the current one', () => {
  // Ship-check adversarial finding on the shared-queue fix: advancing the
  // shared index past a REJECTED candidate without retrying the next one
  // would let critic A silently consume critic B's real URL when A's own
  // first candidate fails validation (here, a /tag/ listing page BWW
  // sometimes links by mistake). The fix retries within the same outlet's
  // queue until it finds a valid candidate or runs out.
  const finkleUrl = 'https://nystagereview.com/2026/04/15/the-fear-of-13-adrien-brody-acquits-himself-as-death-row-convict/';

  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "articleBody": "Let's see what the critics had to say... David Finkle, New York Stage Review: Finkle praises the show's daring commitment to its bleak subject matter.",
  "liveBlogUpdate": [
    { "@type": "BlogPosting", "author": { "name": "New York Stage Review - Frank Scheck" }, "articleBody": "Scheck says the show feels like a long stretch behind bars." }
  ]
}
</script>
<p>Frank Scheck, <a href="https://nystagereview.com/tag/the-fear-of-13/">New York Stage Review:</a> Scheck says the show feels like a long stretch behind bars.</p>
<p>David Finkle, <a href="${finkleUrl}">New York Stage Review:</a> Finkle praises the show's daring commitment to its bleak subject matter.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(
    html,
    'the-fear-of-13-2026',
    'https://www.broadwayworld.com/article/test',
    'The Fear of 13'
  );

  const nysrs = reviews.filter((r) => r.outletId === 'nysr');
  const scheck = nysrs.find((r) => r.criticName === 'Frank Scheck');
  const finkle = nysrs.find((r) => r.criticName === 'David Finkle');
  assert.ok(scheck, 'expected a Frank Scheck NYSR entry');
  assert.ok(finkle, 'expected a David Finkle NYSR entry');

  // Scheck's own candidate (the /tag/ page) is rejected, so he should retry
  // the next candidate in the queue rather than stealing Finkle's real URL.
  assert.strictEqual(scheck.url, finkleUrl);
  assert.strictEqual(finkle.url, null,
    'the queue is exhausted after Scheck retries into it — Finkle stays null, not duplicated');
});
