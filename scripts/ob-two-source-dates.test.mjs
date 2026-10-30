// BRO-6630: two-source dating rules for pre-2020 Off-Broadway census candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLongDate, parseBwwShowPage, parseBroadwayComPage, broadwayComSlug, parseBwwBrowsePage, decideTwoSource, pickBwwUrl, venuesAgree } = require('./ob-two-source-dates.js');

const BWW_PAGE = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"TheaterEvent","name":"Bella Bella Off-Broadway","location":{"@type":"PerformingArtsTheater","name":"City Center Stage 1"}}</script>
<div><span class="show-meta__value">Off-Broadway</span></div><span>Previews</span> <span>October 01, 2019</span>
<strong>Opened: </strong><span style="color:white;">October 22, 2019</span><br><strong>Closing: </strong><span style="color:white;">December 01, 2019</span><br>`;

const base = { fromIso: '2019-06-01', toIso: '2020-05-31', todayIso: '2026-10-30' };
const bww = { venue: 'City Center Stage 1', previews: '2019-10-01', opening: '2019-10-22', closing: '2019-12-01' };
const tm = { venue: 'New York City Center - Stage I', previewsStartDate: '2019-10-01', openingDate: '2019-10-22', closingDate: '2019-12-01' };

test('venuesAgree', () => {
  assert.equal(venuesAgree('City Center Stage 1', 'New York City Center - Stage I'), true);
  assert.equal(venuesAgree('Linda Gross Theater', 'Atlantic Theater Company'), true);
  assert.equal(venuesAgree('Primary Stages', 'Cherry Lane Theatre'), false);
  assert.equal(venuesAgree('Public Theater/Anspacher Theater', 'The Public Theater'), true);
});

test('parseLongDate', () => {
  assert.equal(parseLongDate('October 22, 2019'), '2019-10-22');
  assert.equal(parseLongDate('Smarch 1, 2019'), null);
});

test('parseBwwShowPage reads dates, venue and market', () => {
  const p = parseBwwShowPage(BWW_PAGE);
  assert.deepEqual(p, { name: 'Bella Bella Off-Broadway', venue: 'City Center Stage 1', previews: '2019-10-01', opening: '2019-10-22', closing: '2019-12-01', offBroadway: true });
});

test('parseBwwBrowsePage reads title, url, date, venue', () => {
  const html = `<article class="browse-shows-show-list__item" role="listitem"><a class="browse-shows-show-list__title" href="https://www.broadwayworld.com/shows/Daniels-Husband-331886.html">
    Daniel&#039;s Husband </a><p><span class="browse-shows-show-list__date">April 4, 2017</span><span class="browse-shows-show-list__theatre">Primary Stages</span></p></article>`;
  assert.deepEqual(parseBwwBrowsePage(html), [{ title: "Daniel's Husband", url: 'https://www.broadwayworld.com/shows/Daniels-Husband-331886.html', date: '2017-04-04', venue: 'Primary Stages' }]);
});

test('pickBwwUrl normalizes the newer /cast form and refuses other titles', () => {
  assert.equal(pickBwwUrl([{ url: 'https://www.broadwayworld.com/shows/Describe-the-Night-332068/cast' }], 'Describe the Night'), 'https://www.broadwayworld.com/shows/Describe-the-Night-332068.html');
  assert.equal(pickBwwUrl([{ url: 'https://www.broadwayworld.com/shows/Night-Music-1.html' }], 'Describe the Night'), null);
});

test('accepts when both sources agree', () => {
  const v = decideTwoSource({ ...base, bww, tm, firstReview: '2019-10-22' });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.dates, { previewsStartDate: '2019-10-01', openingDate: '2019-10-22', closingDate: '2019-12-01' });
});

test('TM storing the first preview as its opening still corroborates (BRO-6470)', () => {
  const v = decideTwoSource({ ...base, bww, tm: { ...tm, previewsStartDate: null, openingDate: '2019-10-01' }, firstReview: '2019-10-23' });
  assert.equal(v.ok, true, v.reason);
});

test('refuses a closing gap over a day', () => {
  assert.match(decideTwoSource({ ...base, bww, tm: { ...tm, closingDate: '2019-12-08' }, firstReview: '2019-10-22' }).reason, /closing disagrees/);
});

test('refuses an opening with no second source', () => {
  const v = decideTwoSource({ ...base, bww, tm: { ...tm, previewsStartDate: '2019-09-20', openingDate: '2019-10-10' }, firstReview: '2019-10-22' });
  assert.match(v.reason, /no second source/);
});

test('refuses BWW opening equal to its first preview when TM lists an earlier date (Caesar and Cleopatra class)', () => {
  const b = { ...bww, previews: '2019-10-22', opening: '2019-10-22' };
  const v = decideTwoSource({ ...base, bww: b, tm: { ...tm, previewsStartDate: '2019-10-01', openingDate: '2019-10-22' }, firstReview: '2019-10-22' });
  assert.match(v.reason, /equals its first preview/);
});

test('refuses an opening a week or more before the first write-up', () => {
  const v = decideTwoSource({ ...base, bww, tm, firstReview: '2019-11-05' });
  assert.match(v.reason, /days from the first write-up/);
});

test('refuses venues that name different houses', () => {
  assert.match(decideTwoSource({ ...base, bww, tm: { ...tm, venue: 'Cherry Lane Theatre' }, firstReview: '2019-10-22' }).reason, /venues disagree/);
});

test('refuses a run starting outside the window, a short run, and a missing TM row', () => {
  assert.match(decideTwoSource({ ...base, fromIso: '2019-11-01', bww, tm, firstReview: '2019-10-22' }).reason, /outside/);
  const short = { ...bww, closing: '2019-10-10' };
  assert.match(decideTwoSource({ ...base, bww: short, tm: { ...tm, closingDate: '2019-10-10' }, firstReview: '2019-10-22' }).reason, /shorter than 14 days|outside|days from/);
  assert.match(decideTwoSource({ ...base, bww, tm: null, firstReview: '2019-10-22' }).reason, /no TheaterMania or Broadway.com listing/);
});

test('parseLongDate accepts Broadway.com month abbreviations', () => {
  assert.equal(parseLongDate('Mar 27, 2018'), '2018-03-27');
  assert.equal(parseLongDate('Sept 3, 2017'), '2017-09-03');
  assert.equal(parseLongDate('Ma 3, 2017'), null);
});

test('parseBroadwayComPage reads dates and venue; broadwayComSlug drops apostrophes', () => {
  const html = `<meta property="og:title" content="Mlima&#x27;s Tale"><meta name="description" content="Get official tickets to Mlima&#x27;s Tale at the Martinson Theater at Joseph Papp Public Theater from the trusted Broadway.com source.">
  <h3 class="showpage__about-the-show--spec-name">Show Dates</h3> <div class="showpage__about-the-show--content"> Previews: Mar 27, 2018 &bull; Opening: Apr 15, 2018 • Closing: Jun 3, 2018 </div>`;
  assert.deepEqual(parseBroadwayComPage(html), { title: "Mlima's Tale", venue: 'Martinson Theater at Joseph Papp Public Theater', previews: '2018-03-27', opening: '2018-04-15', closing: '2018-06-03' });
  assert.equal(broadwayComSlug("Mlima’s Tale"), 'mlimas-tale');
  assert.equal(broadwayComSlug('X: Or, Betty Shabazz v. the Nation'), 'x-or-betty-shabazz-v-the-nation');
});

test('refuses a run that previews in the window but opens after it', () => {
  const b = { ...bww, previews: '2020-05-25', opening: '2020-06-10', closing: '2020-07-20' };
  const t = { ...tm, previewsStartDate: '2020-05-25', openingDate: '2020-06-10', closingDate: '2020-07-20' };
  assert.match(decideTwoSource({ ...base, bww: b, tm: t, firstReview: '2020-06-10' }).reason, /opens 2020-06-10, after/);
});
