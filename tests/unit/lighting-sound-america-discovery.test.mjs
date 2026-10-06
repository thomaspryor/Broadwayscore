import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scraper = require('../../scripts/lib/scraper');
const { searchOutletSites, selectApplicableSiteSearchOutlets } = require('../../scripts/lib/site-search-discovery');
const { classifyGap } = require('../../scripts/lib/review-gap-triage');
const outletId = 'lighting-and-sound-america';
const title = 'Mrs. Stern Wanders the Prussian State Library';
const url = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=2PK89K';
// Minimal index markup, not copyrighted review text. The known story was
// indexed on 2024-11-01; it must not be assigned to the 2026 transfer.
const row = (date, href = 'story.asp?ID=2PK89K', headline = title) =>
  `<tr><td>${date ? `(${date})` : ''}</td><td><a href="${href}">Theatre in Review: ${headline} (Luna Stage/59E59)</a></td></tr>`;
async function discover(html, show) {
  const fetch = mock.method(scraper, 'fetchPage', async () => ({ content: html, source: 'brightdata', format: 'html' }));
  try {
    const ids = selectApplicableSiteSearchOutlets('broadway', show, new Set(), false).filter(id => id === outletId);
    return await searchOutletSites(title, ids, { show, openingDate: show.openingDate, market: 'broadway', skipJs: true });
  } finally { fetch.mock.restore(); }
}
test('known LSA review enters the pipeline without manual URL ingestion', async () => {
  const show = { id: 'mrs-stern-2024', title, category: 'off-broadway', previewsStartDate: '2024-10-18', openingDate: '2024-10-24', closingDate: '2024-11-10' };
  const results = await discover(`<table>${row('11/1/2024')}</table>`, show);
  assert.equal(results.length, 1, 'outlet-native discovery must find opaque story.asp IDs');
  assert.equal(results[0].url, url);
  assert.equal(results[0].publishDate, '2024-11-01');
  assert.equal(results[0].outletId, outletId);
  assert.notEqual(classifyGap({ reviewTextsExists: results.length > 0, inReviewsJson: false, inLiveProd: false, exclusionRule: null }), 'true-missed-discovery');
});
test('older same-title review cannot attach to the 2026 transfer', async () => {
  const results = await discover(`<table>${row('11/1/2024')}</table>`, { id: 'mrs-stern-2026', title, category: 'off-broadway', openingDate: '2026-09-12' });
  assert.deepEqual(results, []);
});
test('undated and external stories fail closed', async () => {
  const results = await discover(`<table>${row('')}${row('9/15/2026', 'https://example.com/news/story.asp?ID=OTHER')}</table>`, { title, category: 'off-broadway', openingDate: '2026-09-12' });
  assert.deepEqual(results, []);
});
test('backfill fetches the next month and preserves dates through the dispatcher', async () => {
  const calls = [];
  const fetch = mock.method(scraper, 'fetchPage', async target => {
    calls.push(target);
    return { content: `<table>${target.endsWith('m=11&y=2024') ? row('11/1/2024') : row('10/1/2024', 'story.asp?ID=OLD')}</table>` };
  });
  try {
    const show = { title, category: 'off-broadway', openingDate: '2024-10-24' };
    const results = await searchOutletSites(title, [outletId], { show, openingDate: show.openingDate });
    assert.equal(results.length, 1);
    assert.equal(results[0].dateSource, 'outlet-news-index');
    assert.ok(calls.some(target => target.endsWith('m=11&y=2024')));
  } finally { fetch.mock.restore(); }
});
test('nested tables and prior date rows are supported without borrowing another story date', () => {
  const { parseLightingSoundAmericaIndex: parse } = require('../../scripts/lib/lighting-sound-america-discovery');
  const show = { openingDate: '2024-10-24' };
  const html = `<table><tr><td><table><tr><td>(11/1/2024)</td></tr>${row('')}</table></td></tr>${row('', 'story.asp?ID=NODATE')}</table>`;
  assert.deepEqual(parse(html, title, show).map(r => r.url), [url]);
  assert.deepEqual(parse(`<table>${row('2/30/2024')}</table>`, title, show), []);
  assert.deepEqual(parse(`<table>${row('11/1/2024')}</table>`, title, { openingDate: 'invalid' }), []);
});
test('a title mentioned in the venue or another show headline is not a review match', () => {
  const { parseLightingSoundAmericaIndex: parse } = require('../../scripts/lib/lighting-sound-america-discovery');
  assert.deepEqual(parse(`<table>${row('11/1/2024', 'story.asp?ID=OTHER', 'Mrs. Stern Goes Home')}</table>`, title, { openingDate: '2024-10-24' }), []);
});
test('registry identifies LSA as a free web outlet', () => {
  const registry = require('../../data/outlet-registry.json');
  assert.equal(registry.outlets[outletId].accessModel, 'free');
});
test('archive failure does not discard a discovered review', async () => {
  const fetch = mock.method(scraper, 'fetchPage', async target => {
    if (target.includes('archive.asp')) throw new Error('HTTP 404');
    return { content: `<table>${row('11/1/2024')}</table>` };
  });
  const warn = mock.method(console, 'warn', () => {});
  try {
    const show = { title, category: 'off-broadway', openingDate: '2024-10-24' };
    const results = await searchOutletSites(title, [outletId], { show });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, url);
    assert.equal(warn.mock.callCount(), 2);
  } finally { fetch.mock.restore(); warn.mock.restore(); }
});
