import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { searchTerms, decodeEntities, reviewWindow, parseWpItems, parseBtgListing, wosItems, hubItems, btgItems } = require('./uk-live-index.js');
const { matchCensusItems } = require('./uk-regional-census-match.js');

const show = { id: 'ben-and-imo-royal-shakespeare-regional-2024', title: 'Ben and Imo', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', city: 'stratford-upon-avon-uk', openingDate: '2024-03-10', closingDate: '2024-04-13' };

test('searchTerms strips quotes and adds the pre-colon head', () => {
  assert.deepEqual(searchTerms("Hen's Night"), ['Hens Night', 'Hen s Night']);
  assert.deepEqual(searchTerms('A Christmas Carol: A Ghost Story'), ['A Christmas Carol: A Ghost Story', 'A Christmas Carol']);
});

test('reviewWindow runs from 60 days before opening to 60 days after closing', () => {
  assert.deepEqual(reviewWindow(show), { after: '2024-01-10', before: '2024-06-13' });
  assert.equal(reviewWindow({ title: 'x' }), null);
  assert.equal(reviewWindow({ openingDate: '2025-01-10' }).before, '2025-06-10'); // no close: 150 days after opening, plus a day
});

test('parseWpItems reads WordPress rows and survives junk', () => {
  const body = JSON.stringify([{ link: 'https://x/a', date: '2024-03-12T09:00:00', title: { rendered: 'Ben &amp; Imo &#8211; Swan Theatre' } }, { link: 'https://x/b' }]);
  assert.deepEqual(parseWpItems(body, 'thereviewshub'), [{ url: 'https://x/a', headline: 'Ben & Imo \u2013 Swan Theatre', publishDate: '2024-03-12', outletId: 'thereviewshub' }]);
  assert.deepEqual(parseWpItems('not json', 'x'), []);
  assert.deepEqual(parseWpItems('{"code":"rest_post_invalid_page_number"}', 'x'), []);
});

const BTG_HTML = `<div id="review_23039" class="listing"><a class="index-link" href="/reviews/ben-and-imo-swan-theatre-s-23039"><h3>Ben and Imo</h3>
<p><time datetime="2024-03-08">8</time>&ndash;<time datetime="2024-04-13">13 April 2024</time></p></a></div>
<div id="review_1" class="listing"><a href="/reviews/no-dates-1"><h3>No Dates</h3></a></div>`;

test('parseBtgListing takes the run start as the date and skips rows without one', () => {
  assert.deepEqual(parseBtgListing(BTG_HTML), [{ url: 'https://www.britishtheatreguide.info/reviews/ben-and-imo-swan-theatre-s-23039', headline: 'Ben and Imo', publishDate: '2024-03-08', outletId: 'british-theatre' }]);
});

test('readers feed the census matcher: right house matches, another house and an old run do not', async () => {
  const wp = (rows) => JSON.stringify(rows.map(([link, date, t]) => ({ link, date, title: { rendered: t } })));
  const get = async (url) => {
    if (url.includes('whatsonstage')) return wp([
      ['https://www.whatsonstage.com/news/ben-and-imo-at-the-rsc-review_1/', '2024-03-12T10:00:00', 'Ben and Imo at the RSC review'],
      ['https://www.whatsonstage.com/news/ben-and-imo-at-the-old-vic-review_2/', '2024-03-12T10:00:00', 'Ben and Imo at the Old Vic review'],
    ]);
    if (url.includes('thereviewshub')) return wp([['https://www.thereviewshub.com/ben-and-imo-swan-theatre-stratford-upon-avon/', '2024-03-12T10:00:00', 'Ben and Imo &#8211; Swan Theatre, Stratford-upon-Avon']]);
    return BTG_HTML;
  };
  const items = [...await wosItems(show, get), ...await hubItems(show, get), ...await btgItems(show, get)];
  const m = matchCensusItems(items, [show], new Map(), (u) => u);
  const urls = m.matched.map((x) => x.url).sort();
  assert.ok(urls.some((u) => u.includes('thereviewshub.com/ben-and-imo-swan')));
  assert.ok(urls.some((u) => u.includes('britishtheatreguide.info/reviews/ben-and-imo-swan-theatre-s-23039')));
  assert.ok(!urls.some((u) => u.includes('old-vic')), 'a review of another house is not matched');
});

test('decodeEntities leaves an out-of-range numeric entity alone instead of throwing', () => {
  assert.equal(decodeEntities('a &#99999999999; b &#x110000; c &#8211;'), 'a &#99999999999; b &#x110000; c –');
});

test('searchTerms also tries the apostrophe as a space, and entities &apos; and &hellip; decode', () => {
  assert.deepEqual(searchTerms('Hen’s Night'), ['Hens Night', 'Hen s Night']);
  assert.equal(decodeEntities('Hen&apos;s Night&hellip;'), "Hen's Night...");
});
