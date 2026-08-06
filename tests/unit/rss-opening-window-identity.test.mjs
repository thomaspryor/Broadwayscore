// task #1073: openingWindow RSS feeds must pass an IDENTITY check (title or
// URL slug), not date proximity alone. Before this gate, every NYT-Theater /
// Variety-Legit item published ±2 days of an opening was attributed to that
// show — 8 NYT obituaries/news stubs landed in _pending/the-vessel-off-
// broadway-2026 and an Oh Mary article in _pending/the-pass-off-broadway-2026
// (2026-08-05). Tests require() the real functions (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { titleMatchesShow, urlSlugMatchesShow, isWithinOpeningWindow } = require('../../scripts/lib/rss-discovery.js');

test('urlSlugMatchesShow: NYT review slug matches show title', () => {
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/the-vessel-review-suicide-intervention-squad.html',
    'The Vessel'), true);
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/disruption-review-john-david-washington.html',
    'Disruption'), true);
});

test('urlSlugMatchesShow: unrelated theater-section articles do NOT match', () => {
  const vesselJunk = [
    'https://www.nytimes.com/2026/07/25/theater/kenneth-branagh-royal-shakespeare-company.html',
    'https://www.nytimes.com/2026/07/28/theater/lilly-yokoi-dead.html',
    'https://www.nytimes.com/2026/07/31/theater/boy-george-israel.html',
    'https://variety.com/2026/legit/news/elf-lyons-solo-show-woman-on-the-edge-new-york-1236822695/',
  ];
  for (const u of vesselJunk) {
    assert.equal(urlSlugMatchesShow(u, 'The Vessel'), false, u);
  }
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/bowen-yang-broadway-oh-mary.html',
    'The Pass'), false);
});

test('the combined openingWindow gate: date window alone is NOT sufficient', () => {
  // Simulates checkRSSFeeds' new acceptance for openingWindow feeds:
  // within-window AND (title-match OR slug-match).
  const opening = '2026-07-30';
  const pub = new Date('2026-07-31T12:00:00Z');
  const accept = (itemTitle, link, showTitle) =>
    isWithinOpeningWindow(pub, opening, 2) &&
    (titleMatchesShow(itemTitle, showTitle) || urlSlugMatchesShow(link, showTitle));

  // Real review: stylized headline but slug carries the title → accepted.
  assert.equal(accept(
    'Review: A Suicide Intervention Squad, Underground',
    'https://www.nytimes.com/2026/08/04/theater/the-vessel-review-suicide-intervention-squad.html',
    'The Vessel'), true);
  // Obituary published in-window → rejected on identity.
  assert.equal(accept(
    'Lilly Yokoi, Ballerina of the Bicycle, Dies',
    'https://www.nytimes.com/2026/07/28/theater/lilly-yokoi-dead.html',
    'The Vessel'), false);
  // In-window Oh Mary article vs The Pass → rejected on identity.
  assert.equal(accept(
    'Bowen Yang Will Make His Broadway Debut in Oh, Mary!',
    'https://www.nytimes.com/2026/08/04/theater/bowen-yang-broadway-oh-mary.html',
    'The Pass'), false);
});
