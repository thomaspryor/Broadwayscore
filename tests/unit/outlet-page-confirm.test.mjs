/**
 * BRO-6921: off-Broadway reviews from polled outlets that the feed matcher could
 * not file (subtitled titles, short titles with no credit in the headline), plus
 * the TheaterMania / NYTG / feed-entry config changes.
 * Run: node --test tests/unit/outlet-page-confirm.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findMatchingShows,
  findPageConfirmCandidates,
  pageConfirmsShow,
  pageText,
  titleForms,
  parseWpApiPosts,
  extractListingUrls,
} = require('../../scripts/lib/outlet-listing-helpers.js');
const poller = require('../../scripts/outlet-listing-poller.js');

// Real shows.json shapes (trimmed) for the missed cases.
const ANON = {
  id: 'anon-a-tempest-at-our-kitchen-table-off-broadway-2026', title: 'ANON – a tempest at our kitchen table',
  status: 'open', previewsStartDate: '2026-09-23', openingDate: '2026-10-14', closingDate: '2026-11-16',
  venue: 'Linda Gross Theater', cast: [{ name: 'Deirdre O’Connell' }],
};
const COPPERFIELD = {
  id: 'copperfield-the-new-musical-off-broadway-2026', title: 'Copperfield! The New Musical',
  status: 'open', previewsStartDate: '2026-09-25', openingDate: '2026-10-19', venue: 'Theatre at St. Clement’s',
  creativeTeam: [{ name: 'Gabriel Barre', role: 'Director' }], cast: [{ name: 'Jeffrey Scharf' }],
};
const FISH = {
  id: 'fish-off-broadway-2026', title: 'Fish', status: 'open',
  previewsStartDate: '2026-09-26', openingDate: '2026-10-11', closingDate: '2026-11-01', venue: 'WP Theater',
  creativeTeam: [{ name: 'Melis Aker', role: 'Playwright' }, { name: 'Tatiana Pandiani', role: 'Director' }],
  cast: [{ name: 'Alyssa May Gold' }],
};
const THE_ASK = {
  id: 'the-ask-off-broadway-2026', title: 'The Ask', status: 'open',
  previewsStartDate: '2026-10-06', openingDate: '2026-10-13', closingDate: '2026-11-22', venue: 'Theater 555',
};
const STORIES_WE = { id: 'stories-the-tap-dance-sensation-west-end-2026', title: 'Stories: The Tap Dance Sensation', status: 'open', openingDate: '2026-10-01', venue: 'Peacock Theatre' };
const SHOWS = [ANON, COPPERFIELD, FISH, THE_ASK, STORIES_WE];
const NOW = Date.parse('2026-10-20T11:00:00Z');
const ids = (arr) => arr.map((c) => (c.show || c).id);

describe('titleForms', () => {
  test('main title before a subtitle separator is a second form', () => {
    assert.deepEqual(titleForms(ANON), ['anon a tempest at our kitchen table', 'anon']);
    // normalizeTitle drops a trailing "musical", as findMatchingShows does.
    assert.deepEqual(titleForms(COPPERFIELD), ['copperfield the new', 'copperfield']);
  });
  test('a title with no subtitle, or a trailing "!", keeps one form', () => {
    assert.deepEqual(titleForms(FISH), ['fish']);
    assert.deepEqual(titleForms({ title: 'Oh, Mary!' }).length, 1);
  });
});

describe('the missed items (feed matcher alone files nothing)', () => {
  const cases = [
    ['vulture slug', { url: 'https://www.vulture.com/article/anon-play-washburn-mcc-theater-review.html', headline: '', publishDate: '2026-10-14' }, ANON, false],
    ['nyt slug', { url: 'https://www.nytimes.com/2026/10/14/theater/anon-review-anne-washburn.html', headline: '', publishDate: '2026-10-14' }, ANON, false],
    ['nysr headline', { url: 'https://nystagereview.com/2026/10/20/copperfield-top-drawer-musical-take-on-the-dickens-classic/', headline: 'Copperfield! Top-Drawer Musical Take on the Dickens Classic', publishDate: '2026-10-20' }, COPPERFIELD, true],
    ['theatermania fish', { url: 'https://www.theatermania.com/news/review-fish-a-coming-of-age-comedy-about-isis_1856000/', headline: 'Review: Fish, a Coming-of-Age Comedy About ISIS', publishDate: '2026-10-11' }, FISH, true],
    ['theater scene bare title', { url: 'https://www.theaterscene.net/plays/fish/', headline: 'Fish', publishDate: '2026-10-12' }, FISH, false],
    ['theatermania the ask', { url: 'https://www.theatermania.com/news/review-in-the-ask-a-rich-old-liberal_1856100/', headline: 'Review: In The Ask, a Rich Old Liberal Meets His Match', publishDate: '2026-10-16' }, THE_ASK, true],
  ];
  for (const [name, item, show, reviewOnlyFeed] of cases) {
    test(`${name}: not a feed match, but a page-confirm candidate`, () => {
      const slug = new URL(item.url).pathname;
      assert.deepEqual(ids(findMatchingShows(item.headline, slug, SHOWS, '', { publishDate: item.publishDate, nowMs: NOW })), []);
      assert.deepEqual(ids(findPageConfirmCandidates(item, SHOWS, { reviewOnlyFeed, nowMs: NOW })), [show.id]);
    });
  }
});

describe('findPageConfirmCandidates guards', () => {
  test('outside the run window: no candidate (a 2019 "Fish" review)', () => {
    assert.deepEqual(findPageConfirmCandidates({ url: 'https://x.com/fish-review', headline: 'Review: Fish', publishDate: '2019-05-01' }, SHOWS, { nowMs: NOW }), []);
  });
  test('no review signal on a mixed feed: no candidate', () => {
    assert.deepEqual(findPageConfirmCandidates({ url: 'https://x.com/news/fish-tickets-on-sale', headline: 'Fish tickets on sale now', publishDate: '2026-10-12' }, SHOWS, { nowMs: NOW }), []);
  });
  test('a word inside another word does not count ("Fisher", "Anonymous")', () => {
    assert.deepEqual(findPageConfirmCandidates({ url: 'https://x.com/review-fisher-king', headline: 'Review: The Fisher King, Anonymous no more', publishDate: '2026-10-12' }, SHOWS, { reviewOnlyFeed: true, nowMs: NOW }), []);
  });
  test('a show the feed matcher already filed is not a candidate again', () => {
    const item = { url: 'https://x.com/review-fish', headline: 'Review: Fish', publishDate: '2026-10-12' };
    assert.deepEqual(findPageConfirmCandidates(item, SHOWS, { alreadyMatched: [FISH], nowMs: NOW }), []);
  });
  test('a book review is never a candidate', () => {
    assert.deepEqual(findPageConfirmCandidates({ url: 'https://x.com/books/review-copperfield-novel', headline: 'Book review: Copperfield, the novel', publishDate: '2026-10-20' }, SHOWS, { nowMs: NOW }), []);
  });
});

describe('pageConfirmsShow', () => {
  test('a credit on the page confirms', () => {
    assert.equal(pageConfirmsShow('Fish, by Melis Aker, at WP Theater, is a comedy', FISH, { nowMs: NOW }), true);
  });
  test('the venue confirms a credit-less show (The Ask at Theater 555)', () => {
    assert.equal(pageConfirmsShow('The Ask, now at Theater 555, stars', THE_ASK, { nowMs: NOW }), true);
  });
  test('the title alone does not confirm', () => {
    assert.equal(pageConfirmsShow('Fish is a play about fish', FISH, { nowMs: NOW }), false);
    assert.equal(pageConfirmsShow('The Ask is a new play about asking', THE_ASK, { nowMs: NOW }), false);
  });
  test('a credit without the title does not confirm (different production)', () => {
    assert.equal(pageConfirmsShow('Tatiana Pandiani directs a new play at WP Theater', FISH, { nowMs: NOW }), false);
  });
  test('a one-word venue is not proof', () => {
    const s = { ...THE_ASK, venue: 'Signature' };
    assert.equal(pageConfirmsShow('The Ask at Signature', s, { nowMs: NOW }), false);
  });
  test('a "Stories" slug on an Exeunt review of Creation Stories is not confirmed as the West End show', () => {
    const text = pageText('<h1>Creation Stories and All the Important Importants</h1><p>At La MaMa, a review.</p>');
    assert.equal(pageConfirmsShow(text, STORIES_WE, { nowMs: NOW }), false);
  });
  test('pageText drops scripts and decodes entities', () => {
    assert.equal(pageText('<script>var a="Melis Aker"</script><p>&#x27;Fish&#x27; &amp; more</p>').trim(), "'Fish' & more");
  });
});

describe('confirmOnPage (poller)', () => {
  const stats = () => ({ fetched: 0, confirmed: 0, unconfirmed: 0, overBudget: 0, failed: 0 });
  test('confirms from the fetched page and counts it', async () => {
    const st = stats();
    const out = await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }, { show: THE_ASK }], st, { fetcher:
      async () => '<article><h1>Fish</h1><p>Melis Aker’s play</p></article>' });
    assert.deepEqual(ids(out), [FISH.id]);
    assert.deepEqual(st, { fetched: 1, confirmed: 1, unconfirmed: 1, overBudget: 0, failed: 0 });
  });
  test('a failed fetch confirms nothing', async () => {
    const st = stats();
    const out = await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }], st, { fetcher: async () => { throw new Error('403'); } });
    assert.deepEqual(out, []);
    assert.equal(st.failed, 1);
  });
  test('stops fetching past the per-run cap', async () => {
    const st = { ...stats(), fetched: 10_000 };
    let called = false;
    const out = await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }], st, { fetcher: async () => { called = true; return ''; } });
    assert.deepEqual(out, []);
    assert.equal(called, false);
    assert.equal(st.overBudget, 1);
  });
});

describe('entity decoding in feed headlines', () => {
  test('listing anchors decode &#x27; so the title matches', () => {
    const html = '<a href="https://www.newyorktheatreguide.com/reviews/the-ask-review">&#x27;The Ask&#x27; review: a rich man</a>';
    const items = extractListingUrls(html, 'newyorktheatreguide.com');
    assert.equal(items[0].headline, "'The Ask' review: a rich man");
  });
  test('WP API titles decode &#8217;', () => {
    const items = parseWpApiPosts([{ link: 'https://x.com/a', date: '2026-10-20T00:00:00', title: { rendered: 'Copperfield&#8217;s Return' } }], new Date('2026-10-01'));
    assert.equal(items[0].headline, 'Copperfield’s Return');
  });
});

describe('poller config (BRO-6921)', () => {
  test('TheaterMania polls the WP API with a reviews-only filter', () => {
    assert.equal(poller.OUTLET_STRATEGY_CONFIG.theatermania, undefined);
    const tm = poller.WP_API_CONFIG.theatermania;
    assert.match(tm.apiBase, /theatermania\.com\/wp-json\/wp\/v2\/news$/);
    assert.ok(tm.urlFilter.test('https://www.theatermania.com/news/review-fish_1/'));
    assert.ok(!tm.urlFilter.test('https://www.theatermania.com/news/casting-announced_2/'));
  });
  test('NYTG also polls its off-Broadway list', () => {
    assert.deepEqual(poller.OUTLET_STRATEGY_CONFIG.nytg.extraUrls, ['https://www.newyorktheatreguide.com/reviews/off-broadway']);
  });
  test('former SERP-only outlets have feeds', () => {
    for (const id of ['totaltheater1', 'artsfuse', 'exeunt-magazine']) assert.equal(poller.OUTLET_STRATEGY_CONFIG[id].strategy, 'rss', id);
  });
});

describe('sibling productions (corpus check, BRO-6921)', () => {
  test('a main title shared by two running productions is never a candidate', () => {
    const legacy = { id: 'alvin-ailey-legacy', title: 'Alvin Ailey American Dance Theater: Legacy', status: 'open', openingDate: '2026-09-01', venue: "Sadler's Wells" };
    const newWorks = { id: 'alvin-ailey-new-works', title: 'Alvin Ailey American Dance Theater: New Works', status: 'open', openingDate: '2026-09-01', venue: "Sadler's Wells" };
    const item = { url: 'https://www.thestage.co.uk/reviews/alvin-ailey-american-dance-theater-new-works-review-sadlers-wells-london', headline: '', publishDate: '2026-09-10' };
    // The full title still identifies New Works; the shared main title never picks Legacy.
    assert.deepEqual(findPageConfirmCandidates(item, [legacy, newWorks], { reviewOnlyFeed: true, nowMs: Date.parse('2026-09-11') }).map((c) => c.show.id), ['alvin-ailey-new-works']);
    const bare = { url: 'https://x.com/review-alvin-ailey-american-dance-theater-at-sadlers-wells', headline: '', publishDate: '2026-09-10' };
    assert.deepEqual(findPageConfirmCandidates(bare, [legacy, newWorks], { reviewOnlyFeed: true, nowMs: Date.parse('2026-09-11') }), []);
  });
});

describe('review findings (BRO-6921 second opinion)', () => {
  test('the venue does not confirm a show that has credits on file', () => {
    assert.equal(pageConfirmsShow('Fish at WP Theater is a comedy', FISH, { nowMs: NOW }), false);
  });
  test('a venue shared with another running show confirms neither', () => {
    const PHYL = { id: 'phyl-off-broadway-2026', title: 'Phyl', status: 'open', openingDate: '2026-10-10', venue: 'Theatre Row' };
    const VIOLIN = { id: 'the-blue-violinist-2026', title: 'The Blue Violinist', status: 'open', openingDate: '2026-10-12', venue: 'Theatre Row' };
    assert.equal(pageConfirmsShow('Phyl at Theatre Row', PHYL, { nowMs: NOW, otherShows: [PHYL, VIOLIN] }), false);
    assert.equal(pageConfirmsShow('Phyl at Theatre Row', PHYL, { nowMs: NOW, otherShows: [PHYL] }), true);
  });
  test('a tour "venue" is generic and confirms nothing', () => {
    const TOUR = { id: 'the-ask-tour', title: 'The Ask', status: 'open', openingDate: '2026-10-01', venue: 'North American Tour' };
    assert.equal(pageConfirmsShow('The Ask on its North American Tour', TOUR, { nowMs: NOW }), false);
  });
  test('reviewsOnly is set explicitly, only on review-only feeds', () => {
    const { OUTLET_STRATEGY_CONFIG: S, WP_API_CONFIG: W } = poller;
    assert.equal(W.theatermania.reviewsOnly, true);
    assert.match(W.theatermania.params, /categories=157/);
    assert.equal(W.nysr.reviewsOnly, true);
    assert.equal(S['theater-scene'].reviewsOnly, true);
    assert.equal(S.nytg.reviewsOnly, true);
    assert.ok(!S.observer || !S.observer.reviewsOnly, 'observer feed mixes news');
  });
  test('a fetched page that does not confirm goes in the unconfirmed cache, and the cache expires', async () => {
    const cache = {};
    const st = { fetched: 0, confirmed: 0, unconfirmed: 0, overBudget: 0, failed: 0 };
    await poller.confirmOnPage('https://x.com/ask', [{ show: THE_ASK }], st, { fetcher: async () => '<p>The Ask, a podcast</p>', unconfirmedCache: cache });
    assert.equal(poller.isUnconfirmedCached(cache, 'https://x.com/ask', THE_ASK.id), true);
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')), 'c.json');
    const now = Date.parse('2026-10-20T00:00:00Z');
    fs.writeFileSync(f, JSON.stringify({ entries: { 'a|x': '2026-10-19T00:00:00Z', 'b|x': '2026-10-10T00:00:00Z' } }));
    assert.deepEqual(Object.keys(poller.loadUnconfirmedCache(f, now)), ['a|x']);
    assert.deepEqual(poller.loadUnconfirmedCache(path.join(path.dirname(f), 'missing.json'), now), {});
  });
  test('the writer credit rule uses the publish date passed to confirmOnPage', async () => {
    const st = { fetched: 0, confirmed: 0, unconfirmed: 0, overBudget: 0, failed: 0 };
    const out = await poller.confirmOnPage('https://x.com/f', [{ show: FISH }], st, { fetcher: async () => '<p>Fish by Melis Aker</p>', publishDate: '2026-10-15' });
    assert.deepEqual(ids(out), [FISH.id]);
  });
});

describe('pageText article focus', () => {
  test('a credit only in the sidebar does not confirm', () => {
    const filler = ' A long review paragraph about the evening.'.repeat(20);
    const html = `<nav>Melis Aker</nav><article><h1>Fish</h1><p>${filler}</p></article><aside>More: Melis Aker's new play</aside>`;
    assert.equal(pageConfirmsShow(pageText(html), FISH, { nowMs: NOW }), false);
    const ok = html.replace('<h1>Fish</h1>', '<h1>Fish</h1><p>by Melis Aker</p>');
    assert.equal(pageConfirmsShow(pageText(ok), FISH, { nowMs: NOW }), true);
  });
});

describe('ship-check P1 fixes (BRO-6921)', () => {
  const stats = () => ({ fetched: 0, confirmed: 0, unconfirmed: 0, overBudget: 0, failed: 0 });
  test('an undated item (listing page) needs the page date, and only while the show runs', async () => {
    const c = findPageConfirmCandidates({ url: 'https://x.com/reviews/fish-review', headline: 'Fish' }, SHOWS, { nowMs: NOW, reviewOnlyFeed: true });
    assert.deepEqual(c.map((x) => [x.show.id, x.needsPageDate]), [[FISH.id, true]]);
    assert.deepEqual(findPageConfirmCandidates({ url: 'https://x.com/reviews/fish-review', headline: 'Fish' }, SHOWS, { nowMs: Date.parse('2027-03-01'), reviewOnlyFeed: true }), []);
    const page = (d) => `<meta property="article:published_time" content="${d}T10:00:00Z"><h1>Fish</h1><p>by Melis Aker</p>`;
    const inRun = await poller.confirmOnPage('https://x.com/reviews/fish-review', c, stats(), { fetcher: async () => page('2026-10-14') });
    assert.deepEqual(ids(inRun), [FISH.id]); assert.equal(inRun.pageDate, '2026-10-14');
    const oldRun = await poller.confirmOnPage('https://x.com/reviews/fish-review', c, stats(), { fetcher: async () => page('2024-03-01') });
    assert.equal(oldRun.length, 0);
    const noDate = await poller.confirmOnPage('https://x.com/reviews/fish-review', c, stats(), { fetcher: async () => '<h1>Fish</h1><p>by Melis Aker</p>' });
    assert.equal(noDate.length, 0);
    assert.deepEqual(ids(findPageConfirmCandidates({ url: 'https://x.com/reviews/fish-review', headline: 'Fish', publishDate: '2026-10-15' }, SHOWS, { nowMs: NOW, reviewOnlyFeed: true })), [FISH.id]);
  });
  test('a page without the title (bot wall) is unreadable for a day, never "not this show" for a week', async () => {
    const cache = {}; const st = stats();
    const out = await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }], st, { fetcher: async () => '<p>Checking your browser</p>', unconfirmedCache: cache });
    assert.deepEqual(out, []);
    assert.equal(st.failed, 1); assert.equal(st.unconfirmed, 0);
    assert.deepEqual(Object.keys(cache), ['https://x.com/fish|*unreadable*']);
    assert.equal(poller.isUnconfirmedCached(cache, 'https://x.com/fish', THE_ASK.id), true);
  });
  test('a failed fetch is marked unreadable too', async () => {
    const cache = {}; const st = stats();
    await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }], st, { fetcher: async () => { throw new Error('403'); }, unconfirmedCache: cache });
    assert.equal(Object.keys(cache).length, 1);
  });
  test('unreadable marks expire after a day, unconfirmed after a week', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')), 'c.json');
    fs.writeFileSync(f, JSON.stringify({ entries: { 'u|*unreadable*': '2026-10-18T00:00:00Z', 'u|show': '2026-10-18T00:00:00Z' } }));
    assert.deepEqual(Object.keys(poller.loadUnconfirmedCache(f, Date.parse('2026-10-20T00:00:00Z'))), ['u|show']);
  });
  test('the fetcher gets a check that the page names a candidate title', async () => {
    let check;
    await poller.confirmOnPage('https://x.com/fish', [{ show: FISH }], stats(), { fetcher: async (u, looksRight) => { check = looksRight; return '<p>Fish by Melis Aker</p>'; } });
    assert.equal(check('<p>Checking your browser</p>'), false);
    assert.equal(check('<h1>Fish</h1>'), true);
  });
  test('general-arts feeds must page-confirm every match', () => {
    for (const id of ['artsfuse', 'exeunt-magazine']) assert.equal(poller.OUTLET_STRATEGY_CONFIG[id].pageConfirmAll, true, id);
    assert.ok(!poller.OUTLET_STRATEGY_CONFIG.totaltheater1.pageConfirmAll);
  });
});
