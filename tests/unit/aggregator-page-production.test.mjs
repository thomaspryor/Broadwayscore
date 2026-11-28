/**
 * BRO-3121: an LBO page title-matched to a revived show keeps its excerpts but
 * not its star score unless its date or venue places it in the current run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkAggregatorPageProduction, extractPageDateFromHtml } = require('../../scripts/lib/aggregator-page-production.js');

// jane-eyre-off-west-end-2026 as in shows.json on 2026-09-08.
const JANE_EYRE = {
  id: 'jane-eyre-off-west-end-2026', title: 'Jane Eyre', venue: 'Southwark Playhouse Elephant',
  category: 'off-west-end', market: 'west-end',
  previewsStartDate: '2026-08-28', openingDate: '2026-09-08', closingDate: '2026-10-24',
};
const pad = 'x'.repeat(200);
const page = ({ date, body }) => `<html><head>${date ? `<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"${date}T09:00:00+00:00"}</script>` : ''}</head><body><nav>Gielgud Theatre Lyceum Theatre Southwark Playhouse</nav>${pad}<div class="pmain"><p>${body}</p></div></body></html>`;

test('the 2026-09-08 incident: a dated Bristol Old Vic post is not corroborated', () => {
  const html = page({ date: '2017-09-26', body: 'Sally Cookson\'s devised production for the Bristol Old Vic and National Theatre is a thrilling piece of storytelling.' });
  const r = checkAggregatorPageProduction({ html, show: JANE_EYRE });
  assert.equal(r.corroborated, false);
  assert.match(r.reason, /before_preview/);
  assert.equal(r.outOfRun, true); // callers write none of its rows
  assert.equal(r.pageDate, '2017-09-26');
});

test('an undated post that never names the venue is not corroborated', () => {
  const html = page({ body: 'Sally Cookson\'s production for the Bristol Old Vic is thrilling.' });
  const r = checkAggregatorPageProduction({ html, show: JANE_EYRE });
  assert.equal(r.corroborated, false);
  assert.equal(r.outOfRun, undefined); // undated: excerpts kept, stars dropped
});

test('a post dated inside the run is corroborated', () => {
  const html = page({ date: '2026-09-09', body: 'A fresh musical take on the novel.' });
  assert.equal(checkAggregatorPageProduction({ html, show: JANE_EYRE }).corroborated, true);
});

test('an undated post naming the venue is corroborated', () => {
  const html = page({ body: 'This new musical at Southwark Playhouse is a triumph.' });
  assert.equal(checkAggregatorPageProduction({ html, show: JANE_EYRE }).corroborated, true);
});

test('an out-of-window date wins over a venue mention', () => {
  const html = page({ date: '2015-01-10', body: 'At Southwark Playhouse years ago.' });
  assert.equal(checkAggregatorPageProduction({ html, show: JANE_EYRE }).corroborated, false);
});

test('a declared prior run counts as this production', () => {
  const show = { ...JANE_EYRE, priorRuns: [{ openingDate: '2017-09-01', closingDate: '2017-12-01' }] };
  const html = page({ date: '2017-09-26', body: 'review' });
  assert.equal(checkAggregatorPageProduction({ html, show }).corroborated, true);
});

test('extractPageDateFromHtml reads JSON-LD, meta and <time>', () => {
  assert.equal(extractPageDateFromHtml(page({ date: '2026-09-09', body: '' })), '2026-09-09');
  assert.equal(extractPageDateFromHtml(`${pad}<meta property="article:published_time" content="2026-01-02T00:00:00Z">`), '2026-01-02');
  assert.equal(extractPageDateFromHtml(`${pad}<time datetime="2025-05-06">May</time>`), '2025-05-06');
  assert.equal(extractPageDateFromHtml(`${pad}`), null);
});

test('venues named only in page chrome do not corroborate (real LBO fixture, dates removed)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(new URL('../fixtures/star-ratings/london-box-office.html', import.meta.url), 'utf8')
    .replace(/"datePublished"\s*:\s*"[^"]*"/g, '"x":""')
    .replace(/article:published_time/g, 'x')
    .replace(/<time[^>]*>/gi, '');
  const at = (venue) => checkAggregatorPageProduction({ html, show: { ...JANE_EYRE, venue, previewsStartDate: null, openingDate: null, closingDate: null } }).corroborated;
  for (const venue of ['Gielgud Theatre', 'Lyceum Theatre', 'London Palladium', 'Prince Edward Theatre']) {
    assert.equal(at(venue), false, venue);
  }
  assert.equal(at('Garrick Theatre'), true); // the review's own venue, named in its body
});
