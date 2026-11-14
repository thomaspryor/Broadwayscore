// BRO-6427: the WE historical TR probe (data/audit/we-historical-tr-probe.json,
// 2026-11-02) parsed 0 reviews for three shows. The card read the picked links
// as listings-index pages. They are not: each is the issue page that carries
// the production (the issue's own contents list it at that page, and the
// opening date matches). The zeros came from the PDF parser, fixed and tested
// in scripts/lib/tr-pdf-parse.test.mjs against the committed skeletons.
//
// This test pins the picker half of the card on the real search results the
// probe recorded: the per-production page wins, and a listings/index card
// never does, even one at our venue and listed first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickTrProduction } = require('./tr-production-pick.js');
const { isLondonVenue } = require('./tr-london-venue.js');

const TR = 'https://www.theatrerecord.com';
const r = (title, venue, path) => ({ title, venue, link: `${TR}${path}` });

// Show rows (public facts from shows.json) and the probe's trResults, verbatim.
const CASES = [
  {
    show: { id: 'the-end-of-longing-west-end-2016', title: 'The End of Longing', venue: 'Playhouse Theatre', previewsStartDate: '2016-02-02', openingDate: '2016-02-11', closingDate: '2016-05-14', status: 'closed' },
    review: '/archive/volume/36/page/117',
    results: [r('End of Longing (The)', 'Playhouse', '/archive/volume/36/page/117')],
  },
  {
    show: { id: 'di-and-viv-and-rose-west-end-2015', title: 'Di and Viv and Rose', venue: 'Vaudeville Theatre', previewsStartDate: '2015-01-22', openingDate: '2015-01-29', closingDate: '2015-03-14', status: 'closed' },
    review: '/archive/volume/35/page/95',
    results: [
      r('Di and Viv and Rose', 'Stephen Joseph - Scarborough', '/archive/volume/37/page/875'),
      r('Di and Viv and Rose', 'Vaudeville', '/archive/volume/35/page/95'),
      r('Di and Viv and Rose', 'Hampstead', '/archive/volume/33/page/9'),
    ],
  },
  {
    show: { id: '1984-west-end-2015', title: '1984', venue: 'Playhouse Theatre', previewsStartDate: '2015-06-12', openingDate: '2015-06-18', closingDate: '2015-09-05', status: 'closed' },
    review: '/archive/volume/35/page/632',
    results: [
      r('1984', 'Citizens Theatre, Glasgow\n& touring', '/archive/2026/9/39172-1984'),
      r('Julia. 1984', 'Summerhall - Main Hall, Edinburgh\nEdinburgh Fringe 2025', '/archive/2025/fringe/35877-julia-1984'),
      r('1984', 'Pleasance Courtyard - Above, Edinburgh\nEdinburgh Fringe 2025', '/archive/2025/fringe/35261-1984'),
      r('1984', 'Theatre Royal, Bath\n& touring', '/archive/2024/9/19582-1984'),
      r('1984', 'Summerhall - Old Lab, Edinburgh\nEdinburgh Fringe 2024', '/archive/2024/fringe/19715-1984'),
      r('1984 - Immersive', 'Hackney Town Hall, London', '/archive/2023/10/8716-1984-immersive'),
      r('1984', 'Assembly Roxy, Edinburgh\nEdinburgh Fringe 2023', '/archive/2023/fringe/6061-1984'),
      r('1984', "King's Head", '/archive/volume/37/page/871'),
      r('1984', 'Playhouse', '/archive/volume/36/page/724'),
      r('1984', 'Playhouse', '/archive/volume/35/page/632'),
      r('1984', 'Playhouse', '/archive/volume/34/page/468'),
      r('1984', 'Almeida', '/archive/volume/34/page/144'),
    ],
  },
];

// Index-style links a search card can fall back to.
const INDEX_PATHS = ['/listings/current-west-end', '/archive/volume/35', '/archive/volume/35/index', '/archive/2015/index', '/archive'];

const pick = (results, show, hintVenue = null) => pickTrProduction(results, show, { hintVenue, isLondonVenue });

test('BRO-6427: the probe results pick each show\'s per-production review page', () => {
  for (const { show, review, results } of CASES) {
    assert.equal(pick(results, show)?.link, `${TR}${review}`, show.id);
    assert.equal(pick(results, show, show.venue)?.link, `${TR}${review}`, `${show.id} with hint venue`);
  }
});

test('BRO-6427: a listings-index card at our venue, listed first, never wins the pick', () => {
  for (const { show, review, results } of CASES) {
    const venue = results.find(x => x.link === `${TR}${review}`).venue;
    for (const p of INDEX_PATHS) {
      const withIndex = [r(show.title, venue, p), ...results];
      assert.equal(pick(withIndex, show)?.link, `${TR}${review}`, `${show.id} vs ${p}`);
      // A row with no dates has no press-night window to screen undated
      // links out, so only the link-shape guard stands between it and an index.
      const undated = { ...show, previewsStartDate: null, openingDate: null, status: 'open' };
      const got = pick(withIndex, undated, venue)?.link;
      assert.ok(got && got !== `${TR}${p}`, `${show.id} undated picked index ${p}`);
    }
  }
});

test('BRO-6427: an index card alone yields no pick rather than a listings page', () => {
  for (const { show } of CASES) {
    for (const p of INDEX_PATHS) {
      assert.equal(pick([r(show.title, 'Playhouse', p)], show), null, `${show.id} ${p}`);
      assert.equal(pick([r(show.title, 'Playhouse', p)], { ...show, openingDate: null, previewsStartDate: null }), null, `${show.id} undated ${p}`);
    }
  }
});
