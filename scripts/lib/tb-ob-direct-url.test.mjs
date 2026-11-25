// BRO-8148: the opening-night poller never constructed Talkin' Broadway URLs for off-Broadway
// shows, so Fantasma's review (press night 2026-11-22, /page/ob/11_22_26.html) waited on
// Google News and went live at 12:21am, after the midnight grade mark. Pure, no live data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTbObOpeningCandidates, tryTbDirectUrl } = require('./tb-direct-url.js');

const OB = 'https://www.talkinbroadway.com/page/ob/';
const page = (title, critic = 'Moshe Bloxenheim', date = 'November 22, 2026') =>
  `<html><head><title>Talkin' Broadway Off-Broadway - "${title}" - 11/22/26</title></head><body>` +
  `<h1>${title}</h1><p>Theatre Review by ${critic} - ${date}</p>${'<p>review body text</p>'.repeat(80)}</body></html>`;

function fakeFetch(pages) {
  const seen = [];
  const fn = async (url) => {
    seen.push(url);
    if (pages[url]) return { content: pages[url] };
    return { content: '<html><title>404</title></html>' };
  };
  fn.seen = seen;
  return fn;
}
const quiet = { log() {} };

test('opening-date candidates: same day first, then next day and day before (plain name only)', () => {
  const urls = buildTbObOpeningCandidates('2026-11-22');
  assert.equal(urls[0], `${OB}11_22_26.html`);
  assert.deepEqual(urls.slice(0, 4), ['', 'a', 'b', 'c'].map(s => `${OB}11_22_26${s}.html`));
  assert.ok(urls.includes(`${OB}11_23_26.html`));
  assert.ok(urls.includes(`${OB}11_21_26.html`));
  assert.ok(!urls.includes(`${OB}11_23_26a.html`));
  assert.ok(urls.every(u => !/index\.html/.test(u)));
});

test('opening-date candidates cross month and year ends, padded and unpadded months', () => {
  const urls = buildTbObOpeningCandidates('2026-12-31T00:00:00.000Z');
  assert.ok(urls.includes(`${OB}01_01_27.html`) && urls.includes(`${OB}1_01_27.html`));
  const sep = buildTbObOpeningCandidates('2026-09-29');
  assert.ok(sep.includes(`${OB}9_29_26a.html`) && sep.includes(`${OB}09_29_26.html`));
  assert.deepEqual(buildTbObOpeningCandidates(null), []);
  assert.deepEqual(buildTbObOpeningCandidates('soon'), []);
});

test('off-Broadway show: finds the dated review page, never fetches /page/world/ or the OB index', async () => {
  const fetchPage = fakeFetch({ [`${OB}11_22_26.html`]: page('Fantasma') });
  const r = await tryTbDirectUrl({
    show: { id: 'fantasma-off-broadway-2026', title: 'Fantasma', openingDate: '2026-11-22' },
    year: 2026, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.found, true);
  assert.equal(r.url, `${OB}11_22_26.html`);
  assert.equal(r.source, 'direct-url-construction');
  assert.ok(fetchPage.seen.every(u => u.startsWith(OB) && !/index\.html/.test(u)), JSON.stringify(fetchPage.seen));
});

test('another show filed under the same date is rejected; the suffixed page for this show wins', async () => {
  const fetchPage = fakeFetch({
    [`${OB}11_22_26.html`]: page('Some Other Play', 'Marc Miller'),
    [`${OB}11_22_26a.html`]: page('Fantasma'),
  });
  const r = await tryTbDirectUrl({
    show: { id: 'fantasma-off-broadway-2026', title: 'Fantasma', openingDate: '2026-11-22' },
    year: 2026, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.found, true);
  assert.equal(r.url, `${OB}11_22_26a.html`);
});

test('not published yet: clean miss without an index fallback', async () => {
  const fetchPage = fakeFetch({});
  const r = await tryTbDirectUrl({
    show: { id: 'fantasma-off-broadway-2026', title: 'Fantasma', openingDate: '2026-11-22' },
    year: 2026, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.found, false);
  assert.match(r.reason, /failed verification/);
  assert.doesNotMatch(r.reason, /index/);
});

test('off-Broadway show with no opening date fetches nothing', async () => {
  const fetchPage = fakeFetch({});
  const r = await tryTbDirectUrl({ show: { id: 'x', title: 'Fantasma' }, year: 2026, fetchPage, offBroadway: true, logger: quiet });
  assert.equal(r.found, false);
  assert.equal(fetchPage.seen.length, 0);
});

test('Broadway path is unchanged: world candidates plus the world index', async () => {
  const fetchPage = fakeFetch({});
  await tryTbDirectUrl({ show: { id: 'h', title: 'Hamilton', openingDate: '2015-08-06' }, year: 2015, fetchPage, logger: quiet });
  assert.ok(fetchPage.seen.includes('https://www.talkinbroadway.com/page/world/index.html'));
  assert.ok(fetchPage.seen.every(u => u.includes('/page/world/')));
});

test('an Off-Broadway index override is ignored in favour of the dated pages (BRO-4437)', async () => {
  const fetchPage = fakeFetch({ [`${OB}11_22_26.html`]: page('Fantasma') });
  const r = await tryTbDirectUrl({
    show: { id: 'fantasma-off-broadway-2026', title: 'Fantasma', openingDate: '2026-11-22' },
    year: 2026, overrideUrl: `${OB}index.html`, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.url, `${OB}11_22_26.html`);
  assert.ok(!fetchPage.seen.includes(`${OB}index.html`));
});

test('tbFileHoldsReview: dated OB page held, OB index and flagged files not, Broadway unchanged', async () => {
  const { tbFileHoldsReview } = require('./tb-direct-url.js');
  const ob = { offBroadway: true };
  assert.equal(tbFileHoldsReview({ url: `${OB}11_22_26.html` }, ob), true);
  assert.equal(tbFileHoldsReview({ url: `${OB}9_29_26a.html` }, ob), true);
  assert.equal(tbFileHoldsReview({ url: `${OB}07_17_25.html#:~:text=cast` }, ob), true);
  assert.equal(tbFileHoldsReview({ url: `${OB}index.html` }, ob), false);
  assert.equal(tbFileHoldsReview({ url: `${OB}11_22_26.html`, wrongShow: true }, ob), false);
  assert.equal(tbFileHoldsReview({ url: `${OB}11_22_26.html` }), false);
  assert.equal(tbFileHoldsReview({ url: 'https://www.talkinbroadway.com/page/world/FallenAngels.html' }), true);
  assert.equal(tbFileHoldsReview({ url: 'https://www.talkinbroadway.com/page/world/fallenangels2026.html' }), false);
  assert.equal(tbFileHoldsReview({ url: '' }, ob), false);
});

test('a one-word title does not take another show filed under the same date (Art vs Art of Leaving)', async () => {
  const fetchPage = fakeFetch({ [`${OB}10_22_25.html`]: page('Art of Leaving', 'James Wilson', 'October 22, 2025') });
  const r = await tryTbDirectUrl({
    show: { id: 'art-2025', title: 'Art', openingDate: '2025-10-22' },
    year: 2025, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.found, false);
});

test('a subtitled show matches its main title on the OB page', async () => {
  const fetchPage = fakeFetch({ [`${OB}11_22_26.html`]: page('School Girls') });
  const r = await tryTbDirectUrl({
    show: { id: 'sg', title: 'School Girls; Or, The African Mean Girls Play', openingDate: '2026-11-22' },
    year: 2026, fetchPage, offBroadway: true, logger: quiet,
  });
  assert.equal(r.found, true);
});
