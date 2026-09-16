// BRO-1158 — West End closing-date audit (scripts/audit-we-closing-dates.js).
//
// Tests the pure extraction/classification/discovery functions via
// require() of the real lib files (CLAUDE.md rule 15) — a regression in the
// production code fails here, not a hand-copied re-implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractWestEndClosingDate,
  extractWestEndClosingDateDetailed,
  pageMatchesShowTitle,
} = require('../../scripts/lib/we-closing-date-extract.js');
const { classifyWeClosingDelta } = require('../../scripts/lib/we-closing-date-classify.js');
const { pickBestWetUrl } = require('../../scripts/lib/westend-slug-discovery.js');

// ── we-closing-date-extract.js ──────────────────────────────────────────

test('extractWestEndClosingDate: "Booking until" UK date format', () => {
  const html = '<p>Avenue Q</p><p>Booking until 12 July 2026 at the Menier Chocolate Factory.</p>';
  const r = extractWestEndClosingDate(html, 'Avenue Q');
  assert.equal(r.date, '2026-07-12');
});

test('extractWestEndClosingDate: "must end" phrasing (real WET copy, dracula-west-end-2025)', () => {
  // Verified real-world phrasing from draculawestend.com (closingDateSource
  // for dracula-west-end-2025: "draculawestend.com — must end 31 May").
  const html = '<div>Dracula</div><div>This production must end 31 May 2026.</div>';
  const r = extractWestEndClosingDate(html, 'Dracula');
  assert.equal(r.date, '2026-05-31');
});

test('extractWestEndClosingDate: "extended until" beats an earlier "until" mention', () => {
  const html = `
    <p>Stranger Things: The First Shadow</p>
    <p>Booking until 15 October 2026.</p>
    <p>Now extended until 27 December 2026 by popular demand!</p>
  `;
  const r = extractWestEndClosingDate(html, 'Stranger Things: The First Shadow');
  assert.equal(r.date, '2026-12-27');
});

test('extractWestEndClosingDateDetailed: title_mismatch when page does not mention the show', () => {
  const html = '<p>Some completely unrelated show page with no relevant title.</p>';
  const r = extractWestEndClosingDateDetailed(html, 'Avenue Q');
  assert.equal(r.date, null);
  assert.equal(r.kind, 'title_mismatch');
});

test('extractWestEndClosingDateDetailed: no_date_found when title matches but no anchored date exists', () => {
  const html = '<p>Avenue Q is a hilarious puppet musical playing now at the Menier.</p>';
  const r = extractWestEndClosingDateDetailed(html, 'Avenue Q');
  assert.equal(r.date, null);
  assert.equal(r.kind, 'no_date_found');
});

test('extractWestEndClosingDate: does NOT false-positive on a bare "ends" in unrelated prose', () => {
  // Regression test: an earlier draft anchored on bare /\bends?\b/, which
  // would match ordinary synopsis/review prose with zero booking-page
  // context. "Act One ends with a twist" + an unrelated nearby year mention
  // (e.g. a copyright notice) must NOT be read as a closing date.
  const html = '<p>Avenue Q</p><p>Act One ends with a twist nobody saw coming. &copy; 2019 Menier Chocolate Factory.</p>';
  const r = extractWestEndClosingDateDetailed(html, 'Avenue Q');
  assert.equal(r.date, null);
  assert.equal(r.kind, 'no_date_found');
});

test('extractWestEndClosingDate: quote does not include trailing garbage past the date', () => {
  // Regression test for the quoteEnd off-by-am[0].length bug: quote must end
  // at (or very near) the date text, not extend an extra `am[0].length`
  // characters further into the following sentence.
  const html = '<p>Avenue Q</p><p>Booking until 12 July 2026. Tickets from £25, book now!</p>';
  const r = extractWestEndClosingDate(html, 'Avenue Q');
  assert.ok(r.quote.includes('2026'));
  assert.ok(!r.quote.includes('Tickets from'), `quote leaked trailing text: "${r.quote}"`);
});

test('pageMatchesShowTitle: requires a meaningful title word', () => {
  assert.equal(pageMatchesShowTitle('Come see Avenue Q live on stage', 'Avenue Q'), true);
  assert.equal(pageMatchesShowTitle('Come see Cabaret live on stage', 'Avenue Q'), false);
});

// ── we-closing-date-classify.js ─────────────────────────────────────────

test('classifyWeClosingDelta: no stored closingDate -> NEW_CLOSING_NEEDS_REVIEW', () => {
  const r = classifyWeClosingDelta({ stored: null, extracted: '2026-12-01' });
  assert.equal(r.action, 'NEW_CLOSING_NEEDS_REVIEW');
  assert.equal(r.delta, null);
});

test('classifyWeClosingDelta: extraction later than stored -> EXTENSION', () => {
  const r = classifyWeClosingDelta({ stored: '2026-06-01', extracted: '2026-06-15' });
  assert.equal(r.action, 'EXTENSION');
  assert.equal(r.delta, 14);
});

test('classifyWeClosingDelta: extension beyond the cap -> EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW', () => {
  const r = classifyWeClosingDelta({ stored: '2026-01-01', extracted: '2026-12-01', maxAutoExtensionDays: 180 });
  assert.equal(r.action, 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW');
});

test('classifyWeClosingDelta: extraction much earlier than stored -> NEEDS_HUMAN_REVIEW', () => {
  const r = classifyWeClosingDelta({ stored: '2026-12-01', extracted: '2026-06-01', ambiguousDeltaThresholdDays: 30 });
  assert.equal(r.action, 'NEEDS_HUMAN_REVIEW');
});

test('classifyWeClosingDelta: small delta within threshold -> MATCH', () => {
  const r = classifyWeClosingDelta({ stored: '2026-06-01', extracted: '2026-06-01' });
  assert.equal(r.action, 'MATCH');
  assert.equal(r.delta, 0);
});

test('classifyWeClosingDelta: throws when extracted is missing', () => {
  assert.throws(() => classifyWeClosingDelta({ stored: '2026-06-01', extracted: null }));
});

// Acceptance-criteria regression: BRO-1158 cites 4 WE closing dates manually
// corrected on 2026-05-14 (stored 4 months before this audit shipped, so
// shows.json now already carries the corrected values — see the issue body).
// Of the 4, only stranger-things-the-first-shadow-west-end-2023's correction
// direction and magnitude is stated precisely in the issue text ("off by 35d
// — extension"; corrected value 2026-12-27, implying the wrong stored value
// was 2026-11-22). The other 3 ("off by 2d/1d/4d") don't state direction, so
// their old values aren't reconstructable without fabricating history. This
// test locks in the one fully-verifiable case: fed the real wrong→right pair,
// the classifier must call it EXTENSION, not silently MATCH or misclassify.
test('classifyWeClosingDelta: reproduces the stranger-things WE extension (BRO-1158 acceptance criterion)', () => {
  const r = classifyWeClosingDelta({ stored: '2026-11-22', extracted: '2026-12-27' });
  assert.equal(r.action, 'EXTENSION');
  assert.equal(r.delta, 35);
});

// ── westend-slug-discovery.js ───────────────────────────────────────────

test('pickBestWetUrl: picks a matching westendtheatre.com show URL, skips reviews and unrelated results', () => {
  const results = [
    { url: 'https://www.westendtheatre.com/news/some-roundup-review/', title: 'Avenue Q Reviews: what the critics say' },
    { url: 'https://www.westendtheatre.com/5308/shows/avenue-q/', title: 'Avenue Q Tickets | WestEndTheatre.com' },
    { url: 'https://example.com/avenue-q', title: 'Avenue Q — unrelated site' },
  ];
  const url = pickBestWetUrl(results, 'Avenue Q');
  assert.equal(url, 'https://www.westendtheatre.com/5308/shows/avenue-q/');
});

test('pickBestWetUrl: returns null when no result matches the title', () => {
  const results = [
    { url: 'https://www.westendtheatre.com/1234/shows/cabaret/', title: 'Cabaret Tickets' },
  ];
  const url = pickBestWetUrl(results, 'Avenue Q');
  assert.equal(url, null);
});

test('pickBestWetUrl: returns null on empty results', () => {
  assert.equal(pickBestWetUrl([], 'Avenue Q'), null);
  assert.equal(pickBestWetUrl(null, 'Avenue Q'), null);
});
