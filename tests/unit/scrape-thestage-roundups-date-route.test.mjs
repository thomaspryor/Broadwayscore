/**
 * BRO-6098: The Stage round-up slugs carry no year, so a revived title matched
 * the most recent production and the page-date guard then threw the page away
 * (40+ real round-ups on the 2026-11-03 run). The scraper now routes each page
 * by its own publish date, and the per-show cache no longer hides a second
 * URL for the same title.
 *
 * Runs the real scrapeRoundups() against a fake fetch and a temp archive dir.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ARCHIVE = fs.mkdtempSync(path.join(os.tmpdir(), 'thestage-route-'));
process.env.THESTAGE_ARCHIVE_DIR = ARCHIVE;
process.env.THESTAGE_RATE_LIMIT_MS = '0';

const require = createRequire(import.meta.url);
const { scrapeRoundups, targetsTitle } = require('../../scripts/scrape-thestage-roundups.js');
const { resolveProductionByPageDate, canonicalUrlFromHtml, sameRoundupUrl } = require('../../scripts/lib/aggregator-page-production.js');
const { buildSiblingCategoriesFromShows } = require('../../scripts/lib/show-matching.js');

// Two productions of one title, shaped like shows.json (2025 Theatre Royal
// Drury Lane run, 2026 Globe run). Neither is real data.
const ADO_2025 = { id: 'much-ado-about-nothing-west-end-2025', title: 'Much Ado About Nothing', category: 'west-end',
  status: 'closed', venue: 'Theatre Royal Drury Lane', previewsStartDate: '2025-02-10', openingDate: '2025-02-19', closingDate: '2025-04-05' };
const ADO_2026 = { id: 'much-ado-about-nothing-globe-off-west-end-2026', title: 'Much Ado About Nothing', category: 'off-west-end',
  status: 'open', venue: "Shakespeare's Globe", previewsStartDate: '2026-05-01', openingDate: '2026-05-08', closingDate: '2026-08-30' };
const SHOWS = [ADO_2025, ADO_2026];
const SIBLINGS = buildSiblingCategoriesFromShows(SHOWS);

const URL_2025 = 'https://www.thestage.co.uk/review-round-ups/much-ado-about-nothing-starring-tom-hiddleston-review-round-up';
const URL_2026 = 'https://www.thestage.co.uk/review-round-ups/much-ado-about-nothing-at-shakespeares-globe-review-round-up';

const page = (url, date) => `<!doctype html><html><head>
<title>Much Ado About Nothing review round-up | The Stage</title>
<link rel="canonical" href="${url}">
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"${date}T09:00:00+00:00"}</script>
</head><body><article><h1>Much Ado About Nothing review round-up</h1>
<p>Critics were warm. Arifa Akbar (<a href="https://www.theguardian.com/stage/ado-${date}">Guardian, ★★★★</a>) called it a joy.</p>
<p>Dominic Cavendish (<a href="https://www.telegraph.co.uk/theatre/ado-${date}">Telegraph, ★★★</a>) was less sure.</p>
</article></body></html>`;

const PAGES = { [URL_2025]: page(URL_2025, '2025-02-21'), [URL_2026]: page(URL_2026, '2026-05-09') };

function run(urls) {
  const fetched = [];
  const fetchHtml = async (u) => { fetched.push(u); return PAGES[u]; };
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  return scrapeRoundups(fetchHtml, urls, SHOWS, { siblings: SIBLINGS })
    .then((matched) => ({ matched, fetched }))
    .finally(() => { console.log = log; console.warn = warn; });
}

beforeEach(() => {
  for (const f of fs.readdirSync(ARCHIVE)) fs.rmSync(path.join(ARCHIVE, f));
});

test('a 2025 round-up of a revived title is archived under the 2025 production, not dropped', async () => {
  const { matched } = await run([URL_2025]);
  assert.deepEqual(matched.map(m => m.showId), [ADO_2025.id]);
  assert.ok(fs.existsSync(path.join(ARCHIVE, `${ADO_2025.id}.html`)));
  assert.ok(!fs.existsSync(path.join(ARCHIVE, `${ADO_2026.id}.html`)));
});

test('both productions get their own round-up in one run', async () => {
  const { matched } = await run([URL_2026, URL_2025]);
  assert.deepEqual(matched.map(m => m.showId).sort(), [ADO_2025.id, ADO_2026.id].sort());
});

test('a cached archive of another URL does not hide this URL (it is fetched and routed)', async () => {
  fs.writeFileSync(path.join(ARCHIVE, `${ADO_2026.id}.html`), PAGES[URL_2026]);
  const { matched, fetched } = await run([URL_2026, URL_2025]);
  assert.deepEqual(fetched, [URL_2025]); // URL_2026 is the cached page itself
  assert.deepEqual(matched.map(m => m.showId).sort(), [ADO_2025.id, ADO_2026.id].sort());
});

test('an undated legacy archive holding an earlier revival is refetched, rerouted and quarantined', async () => {
  // Old Browserbase-route archives carry no publish date (seen on 2026-11-09:
  // inter-alia-west-end-2026.html held the 2025 Rosamund Pike round-up).
  const undated = PAGES[URL_2025].replace(/<script type="application\/ld\+json">[^<]*<\/script>/, '');
  fs.writeFileSync(path.join(ARCHIVE, `${ADO_2026.id}.html`), undated);
  const { matched, fetched } = await run([URL_2025]);
  assert.deepEqual(fetched, [URL_2025]);
  assert.deepEqual(matched.map(m => m.showId), [ADO_2025.id]);
  assert.ok(fs.existsSync(path.join(ARCHIVE, `${ADO_2026.id}.html.mismatch`)));
  assert.ok(!fs.existsSync(path.join(ARCHIVE, `${ADO_2026.id}.html`)));
});

test('a dated cached archive of this same URL is used without a fetch', async () => {
  fs.writeFileSync(path.join(ARCHIVE, `${ADO_2026.id}.html`), PAGES[URL_2026]);
  const { matched, fetched } = await run([URL_2026]);
  assert.deepEqual(fetched, []);
  assert.deepEqual(matched.map(m => m.showId), [ADO_2026.id]);
});

test('a page dated outside every production is still dropped', async () => {
  PAGES[URL_2025 + '-old'] = page(URL_2025 + '-old', '2012-06-01');
  const { matched } = await run([URL_2025 + '-old']);
  assert.deepEqual(matched, []);
  assert.deepEqual(fs.readdirSync(ARCHIVE), []);
});

test('resolveProductionByPageDate never routes into another out-of-run production', () => {
  const html = page(URL_2025, '2012-06-01');
  const r = resolveProductionByPageDate({ html, show: ADO_2026, rematch: () => ADO_2025 });
  assert.equal(r.rerouted, false);
  assert.equal(r.show.id, ADO_2026.id);
  assert.equal(r.prod.outOfRun, true);
});

test('resolveProductionByPageDate leaves an in-run page alone', () => {
  const r = resolveProductionByPageDate({ html: page(URL_2026, '2026-05-09'), show: ADO_2026, rematch: () => { throw new Error('not called'); } });
  assert.equal(r.rerouted, false);
  assert.equal(r.prod.outOfRun, undefined);
});

test('canonicalUrlFromHtml / sameRoundupUrl', () => {
  assert.equal(canonicalUrlFromHtml(PAGES[URL_2025]), URL_2025);
  assert.equal(canonicalUrlFromHtml('<meta property="og:url" content="https://x.test/a">'), 'https://x.test/a');
  assert.equal(canonicalUrlFromHtml('<html></html>'), null);
  assert.ok(sameRoundupUrl('https://www.thestage.co.uk/a/b/', 'http://thestage.co.uk/a/b?x=1'));
  assert.ok(!sameRoundupUrl('https://www.thestage.co.uk/a/b', 'https://www.thestage.co.uk/a/c'));
  assert.ok(!sameRoundupUrl(null, null));
});

test('targetsTitle: --shows naming an earlier production keeps the title in play', () => {
  assert.ok(targetsTitle([ADO_2025.id], ADO_2026, SHOWS));
  assert.ok(targetsTitle([ADO_2026.id], ADO_2026, SHOWS));
  assert.ok(!targetsTitle(['hamlet-west-end-2025'], ADO_2026, SHOWS));
});
