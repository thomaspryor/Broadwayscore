'use strict';
/**
 * SYNTHETIC rehearsal fixture for the opening-night lane (BRO-4787, epic BRO-4210 phase 4).
 *
 * A fictional opening with the shapes a real night has: a roundup page citing most outlets, a second aggregator with
 * some overlap, outlet feeds, section index pages needing a per-article date check, a paywalled NYT (no text, only the
 * aggregator thumb), a syndicated critic on two outlets, and decoys that must NOT be published (an interview, an
 * extension story, an unregistered blog, a review dated the wrong week). Review text is generated filler; nothing here
 * is copyrighted. A recorded fixture from a real opening (Paranormal Activity, Aug 25) replaces this once someone with
 * live-page and review-texts access records it; the rehearsal runner takes either, so nothing else changes.
 *
 * Deterministic: no randomness, no clock.
 */
const { canonicalUrl } = require('./discovery');

const SHOW = { id: 'rehearsal-play-2026', title: 'The Rehearsal Play' };
const NIGHT = '2026-10-18';
const SLUG = 'the-rehearsal-play';

// [outletId, host, critic]. Hosts all resolve to a registered outlet (the runner asserts it).
const BWW_OUTLETS = [
  ['nytimes', 'www.nytimes.com', 'Jesse Example'], ['vulture', 'www.vulture.com', 'Jackson Example'],
  ['variety', 'variety.com', 'Frank Example'], ['hollywood-reporter', 'www.hollywoodreporter.com', 'Sam Example'],
  ['deadline', 'deadline.com', 'Greg Example'], ['newyorker', 'www.newyorker.com', 'Vinson Example'],
  ['nypost', 'nypost.com', 'Johnny Example'], ['washpost', 'www.washingtonpost.com', 'Naveen Example'],
  ['wsj', 'www.wsj.com', 'Charles Example'], ['ew', 'ew.com', 'Maureen Example'],
  ['theatermania', 'www.theatermania.com', 'Zachary Example'], ['broadwaynews', 'www.broadwaynews.com', 'Caldwell Example'],
  ['nbcny', 'www.nbcnewyork.com', 'Pat Example'], ['amny', 'www.amny.com', 'Matt Example'],
  ['newsday', 'www.newsday.com', 'Linda Example'], ['nydailynews', 'www.nydailynews.com', 'Chris Example'],
  ['chicagotribune', 'www.chicagotribune.com', 'Chris Example'], // the syndicated critic: same byline, two outlets
  ['usatoday', 'www.usatoday.com', 'Elizabeth Example'], ['ap', 'apnews.com', 'Mark Example'],
  ['bloomberg', 'www.bloomberg.com', 'Jennifer Example'], ['theatrely', 'www.theatrely.com', 'Dan Example'],
  ['stageandcinema', 'www.stageandcinema.com', 'Ed Example'],
];
const DTLI_ONLY = [['latimes', 'www.latimes.com', 'Charles Example'], ['observer', 'observer.com', 'Adam Example'], ['thewrap', 'www.thewrap.com', 'Robert Example']];
const FEED_OUTLETS = [['rollingstone', 'www.rollingstone.com', 'Sarah Example'], ['time', 'time.com', 'Mark Example'], ['cnn', 'www.cnn.com', 'Lisa Example'], ['npr', 'www.npr.org', 'Jeff Example'], ['goldderby', 'www.goldderby.com', 'Tom Example']];
const INDEX_OUTLETS = [['telegraph', 'www.telegraph.co.uk', 'Dominic Example'], ['independent', 'www.independent.co.uk', 'Holly Example'], ['thestage', 'www.thestage.co.uk', 'Fiona Example'], ['financialtimes', 'www.ft.com', 'Sarah Example'], ['dailybeast', 'www.thedailybeast.com', 'Ben Example']];

const reviewUrl = (host, i) => `https://${host}/2026/10/19/theater/${SLUG}-review-${i}`;
const filler = (n) => `${'The staging builds slowly and the second act earns its ending. '.repeat(8)}(synthetic review ${n}).`;

function buildSyntheticFixture() {
  const pages = {};
  const reviews = [];
  let n = 0;
  const add = (outletId, host, critic, via, extra = {}) => {
    n += 1;
    const url = reviewUrl(host, n);
    reviews.push({ outletId, host, criticName: critic, url, via, publishDate: '2026-10-19', text: extra.paywalled ? '' : filler(n), score: extra.paywalled ? null : 60 + (n % 35), aggregator: extra.paywalled ? { thumb: 'Up' } : {}, ...extra });
    return url;
  };

  // BWW roundup: the first 22 outlets; the NYT one is paywalled.
  const roundupUrl = `https://www.broadwayworld.com/article/Review-Roundup-${SLUG.toUpperCase()}-Opens-On-Broadway-20261018`;
  // The last three roundup entries are added to the page half an hour later (a late review the lane must still catch).
  const LATE_FROM = BWW_OUTLETS.length - 3;
  const LATE_AFTER_MS = 30 * 60 * 1000;
  const bwwLinks = BWW_OUTLETS.map(([id, host, critic], i) => {
    const url = add(id, host, critic, 'bww-roundup', id === 'nytimes' ? { paywalled: true } : {});
    return `<a href="${url}?utm_source=bww&partner=rss">${critic}, ${id}</a>`;
  });
  const roundupPage = (links) => `<html><body><nav><a href="https://www.nytimes.com/section/theater">Theater</a></nav><article>${links.join('')}<a href="https://rehearsal-blog.substack.com/p/the-rehearsal-play-review">A Substack critic nobody registered</a><a href="https://www.nytimes.com/2026/10/18/theater/${SLUG}-interview-1">Interview with the cast</a></article><footer><a href="https://www.washingtonpost.com/about/">about</a></footer></body></html>`;
  pages['https://www.broadwayworld.com/'] = `<html><body><a href="${roundupUrl}">Review Roundup: THE REHEARSAL PLAY</a><a href="https://www.broadwayworld.com/article/Review-Roundup-ANOTHER-SHOW-20261010">other</a></body></html>`;
  pages[roundupUrl] = roundupPage(bwwLinks.slice(0, LATE_FROM));
  const waves = [{ afterMs: LATE_AFTER_MS, pages: { [roundupUrl]: roundupPage(bwwLinks) } }];

  // DTLI: re-cites two BWW reviews (dedupe) plus three of its own.
  const dtliPage = 'https://didtheylikeit.com/shows/the-rehearsal-play/';
  const dtliLinks = [reviews[2].url, reviews[3].url].map((u) => `<a href="${u}">repeat</a>`);
  for (const [id, host, critic] of DTLI_ONLY) dtliLinks.push(`<a href="${add(id, host, critic, 'dtli')}">${critic}</a>`);
  pages['https://didtheylikeit.com/'] = `<html><body><a href="${dtliPage}">The Rehearsal Play</a><a href="https://didtheylikeit.com/shows/another-show/">Another</a></body></html>`;
  pages[dtliPage] = `<html><body><article>${dtliLinks.join('')}</article><footer><a href="https://www.thetimes.com/x-review">footer</a></footer></body></html>`;

  // Outlet feeds: five outlets with an on-night review plus decoys.
  const feeds = [];
  for (const [id, host, critic] of FEED_OUTLETS) {
    const url = add(id, host, critic, 'rss');
    const feedUrl = `https://${host}/feed`;
    feeds.push({ url: feedUrl, name: id, outletId: id });
    pages[feedUrl] = `<rss><channel>
      <item><title>Review: The Rehearsal Play</title><link>${url}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
      <item><title>The Rehearsal Play extends through January</title><link>https://${host}/2026/10/19/news/${SLUG}-extends-9</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate></item>
      <item><title>Review: The Rehearsal Play (a revival from last season)</title><link>https://${host}/2025/03/02/theater/${SLUG}-review-old</link><pubDate>Sun, 02 Mar 2025 15:00:00 GMT</pubDate></item>
    </channel></rss>`;
  }

  // Section indexes: dates confirmed per article. One extra link is dated a week early and must be refused.
  const outlets = [];
  for (const [id, host, critic] of INDEX_OUTLETS) {
    const url = add(id, host, critic, 'section-index');
    const indexUrl = `https://${host}/stage`;
    outlets.push({ outletId: id, indexUrl });
    pages[indexUrl] = `<html><body><nav><a href="/stage/${SLUG}-nav-review">nav</a></nav><main><a href="${url}">The Rehearsal Play review</a><a href="https://${host}/stage/${SLUG}-previews-review">The Rehearsal Play review (early)</a></main></body></html>`;
    pages[url] = `<html><head><meta property="article:published_time" content="2026-10-19T09:00:00+01:00"></head><body>review</body></html>`;
    pages[`https://${host}/stage/${SLUG}-previews-review`] = `<html><head><meta property="article:published_time" content="2026-10-11T09:00:00+01:00"></head><body>early</body></html>`;
  }

  // One section-index article date check fails once (a transient 503) and must succeed on a later pass.
  const flakyUrl = reviews.find((r) => r.via === 'section-index').url;
  // When each review's page first showed it (virtual ms after the lane starts): the page-to-live bar counts from here.
  reviews.forEach((r, i) => { r.appearsAfterMs = (r.via === 'bww-roundup' && BWW_OUTLETS.findIndex(([id]) => id === r.outletId) >= LATE_FROM) ? LATE_AFTER_MS : 0; });
  const expectedKeys = reviews.map((r) => canonicalUrl(r.url));
  return {
    kind: 'synthetic', show: SHOW, night: NIGHT, openingDate: NIGHT, pages, waves, flaky: { [flakyUrl]: 1 }, reviews, expectedKeys,
    adapters: { feeds, outlets },
    // Candidates the lane must NOT publish; the runner checks none reaches the ledger.
    decoys: ['https://rehearsal-blog.substack.com/p/the-rehearsal-play-review', `https://www.nytimes.com/2026/10/18/theater/${SLUG}-interview-1`],
  };
}

module.exports = { buildSyntheticFixture, SHOW, NIGHT };
