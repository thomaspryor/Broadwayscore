/**
 * replay-pending-bylines: validate before promoting a stranded _pending review.
 *
 * Incident 2026-06-04 (Beetlejuice WE): the _pending drain promoted junk it found
 * stranded — three WestEndTheatre-roundup URLs filed under telegraph/thestage/times
 * (fabricating fake outlet reviews with the roundup author's byline), a Justin Theroux
 * FILM article, and a Tim Burton interview — all because they mention "Beetlejuice".
 * pendingPromoteRejectReason gates promotion on: aggregator/listing URL, non-theatre
 * news section (wrong production, same title), and verifyAggregatorUrl show-match.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pendingPromoteRejectReason } = require('../../scripts/replay-pending-bylines.js');

const SHOW = { id: 'beetlejuice-west-end-2026', title: 'Beetlejuice', venue: 'Shaftesbury Theatre', openingDate: '2026-05-28' };
const titled = (t) => `<html><head><title>${t}</title></head><body>${t}</body></html>`;
// Same title + a machine-readable publish date (JSON-LD), so the temporal gate
// has a date to act on while checks 1–3 (title token) still pass.
const titledDated = (t, isoDate) =>
  `<html><head><title>${t}</title>` +
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: isoDate })}</script>` +
  `</head><body>${t}</body></html>`;

describe('pendingPromoteRejectReason', () => {
  test('REJECTS a WestEndTheatre roundup URL filed under an outlet', () => {
    const r = pendingPromoteRejectReason(
      'https://www.westendtheatre.com/356598/news/reviews/beetlejuice-the-musical-reviews/',
      titled('Beetlejuice the Musical reviews roundup'), SHOW);
    assert.ok(r && /aggregator/.test(r), `expected aggregator reject, got ${r}`);
  });

  test('REJECTS a same-title FILM article (wrong production)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/film/article/justin-theroux-jennifer-aniston-beetlejuice',
      titled('Justin Theroux on Beetlejuice'), SHOW);
    assert.ok(r && /non-theatre section \(film\)/.test(r), `expected film reject, got ${r}`);
  });

  // Narrowed 2026-06-05 (ship-check): outlets file REAL theatre reviews under
  // tv/music/lifestyle sections (Daily Mail /tv/, USA Today /entertainment/music/,
  // WashPost /lifestyle/), so those sections must NOT auto-reject — that was destroying
  // real reviews. A genuine theatre review under a /tv/ section is promoted; a same-title
  // interview is left to the downstream LLM non-review classifier, not this URL gate.
  test('does NOT reject a real theatre review filed under /tv/ (false-positive guard)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.dailymail.co.uk/tv/article-15559075/review-Shadowlands-London-Aldwych-Theatre.html',
      titled('Beetlejuice review — Aldwych Theatre'), SHOW);
    assert.equal(r, null, `a real review under /tv/ must not be section-rejected, got ${r}`);
  });

  test('REJECTS a different show entirely (show-match)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/war-horse-review',
      titled('War Horse review'), SHOW);
    assert.ok(r && /not this show/.test(r), `expected show-match reject, got ${r}`);
  });

  test('ALLOWS a genuine theatre review of the right show', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/beetlejuice-review-shaftesbury',
      titled('Beetlejuice review — Shaftesbury Theatre'), SHOW);
    assert.equal(r, null, `expected promote-OK, got reject: ${r}`);
  });
});

// Incident 2026-07-19 (Treneman/Oresteia): the drain promoted a 2017 Edinburgh
// Fringe "Oresteia: This Restless House" Times review into the 2026 West End
// "The Oresteia" show dir and scored it 40. The URL slug carries the shared
// "oresteia" token (so the show-match gate passes) and has NO year segment (so
// the URL-year backstop never fired). Only the article's 2017 publish date
// separates the two same-title productions.
describe('pendingPromoteRejectReason — temporal wrong-production gate', () => {
  const ORESTEIA = {
    id: 'the-oresteia-west-end-2026', title: 'The Oresteia',
    previewsStartDate: '2026-07-02', openingDate: '2026-07-14',
    category: 'west-end', market: 'west-end',
  };
  // The exact stranded _pending URL from the incident.
  const TRENEMAN_URL = 'https://www.thetimes.com/uk/scotland/article/edinburgh-theatre-review-oresteia-this-restless-house-at-the-lyceum-theatre-stz2k8fpn';

  test('REJECTS the Treneman URL (2017 date) — earlier production, same title', () => {
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titledDated('Oresteia: This Restless House review', '2017-08-24'), ORESTEIA);
    assert.ok(r && /outside this production's window/.test(r), `expected temporal reject, got ${r}`);
  });

  test('honors a pre-extracted publishDate arg (4th param) over html', () => {
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titled('Oresteia review'), ORESTEIA, '2017-08-24');
    assert.ok(r && /outside this production's window/.test(r), `expected temporal reject, got ${r}`);
  });

  test('ALLOWS an in-window review of the current production (no false positive)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review-2026',
      titledDated('The Oresteia review', '2026-07-15'), ORESTEIA);
    assert.equal(r, null, `an in-window 2026 review must promote, got reject: ${r}`);
  });

  test('does NOT reject when the article has no extractable date (uncertain → promote)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review',
      titled('The Oresteia review'), ORESTEIA);
    assert.equal(r, null, `dateless article must not be temporally rejected, got ${r}`);
  });

  test('ALLOWS an earlier-run review covered by a declared priorRun', () => {
    const show = { ...ORESTEIA, priorRuns: [{ openingDate: '2017-08-01', closingDate: '2017-09-01', venue: 'Royal Lyceum Edinburgh' }] };
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titledDated('Oresteia review', '2017-08-24'), show);
    assert.equal(r, null, `a declared priorRun window must exempt the date, got reject: ${r}`);
  });
});
