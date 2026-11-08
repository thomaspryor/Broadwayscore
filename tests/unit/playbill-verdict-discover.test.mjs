// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * Unit tests for scripts/lib/playbill-verdict-discover.js.
 *
 * Covers:
 *  - category-page article extraction across the three encodings Playbill uses
 *  - per-show search with injected fetchHtml (no network)
 *  - review-link extraction with the blocklist baked in
 *
 * Run: node --test tests/unit/playbill-verdict-discover.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  VERDICT_CATEGORY_URL,
  VERDICT_SITEMAP_URL,
  extractArticlesFromCategoryPage,
  extractArticlesFromSitemap,
  loadSitemapAccumulator,
  saveSitemapAccumulator,
  accumulateSitemapArticles,
  extractReviewLinksFromArticle,
  searchPlaybillVerdict,
  createFallbackTracker,
} = require('../../scripts/lib/playbill-verdict-discover.js');

// Real Playbill Verdict article URLs observed in `data/review-texts/*/playbill--*.json`
// across 4 different shows (Beaches-2026, Burnout-Paradise-2026, Wild-Party-2026,
// Fiddler-2015). Captures the slug variability Playbill uses.
const REAL_ARTICLE_URLS = {
  beaches:      'https://playbill.com/article/reviews-what-do-the-critics-think-of-beaches-on-broadway',
  burnoutPara:  'https://playbill.com/article/read-the-reviews-for-pony-cams-burnout-paradise-off-broadway',
  wildParty:    'https://playbill.com/article/did-the-reviews-go-wild-for-the-city-center-encores-the-wild-party',
  fiddler:      'https://playbill.com/article/the-verdict-read-reviews-for-the-broadway-revival-of-fiddler-on-the-roof-starring-danny-burstein-com-376292',
};

describe('extractArticlesFromCategoryPage — HTML encoding', () => {
  it('pulls article hrefs from anchor tags with absolute URLs', () => {
    const html = `
      <html><body>
      <a href="https://playbill.com/article/reviews-what-do-the-critics-think-of-beaches-on-broadway">Reviews: Beaches on Broadway</a>
      <a href="https://playbill.com/article/read-the-reviews-for-pony-cams-burnout-paradise-off-broadway">Burnout Paradise review</a>
      </body></html>
    `;
    const articles = extractArticlesFromCategoryPage(html);
    assert.ok(articles.length >= 2, `expected ≥2 articles, got ${articles.length}`);
    assert.ok(articles.some(a => a.url === REAL_ARTICLE_URLS.beaches));
    assert.ok(articles.some(a => a.url === REAL_ARTICLE_URLS.burnoutPara));
  });

  it('normalizes root-relative /article/ hrefs to absolute URLs', () => {
    const html = `<a href="/article/reviews-what-do-the-critics-think-of-beaches-on-broadway">Beaches</a>`;
    const articles = extractArticlesFromCategoryPage(html);
    assert.strictEqual(articles[0].url, REAL_ARTICLE_URLS.beaches);
  });

  it('deduplicates articles that appear multiple times in the HTML', () => {
    const html = `
      <a href="${REAL_ARTICLE_URLS.fiddler}">Fiddler</a>
      <a href="${REAL_ARTICLE_URLS.fiddler}">Fiddler (again)</a>
    `;
    const articles = extractArticlesFromCategoryPage(html);
    assert.strictEqual(articles.length, 1);
  });

  it('anchor-path skips too-short / too-long link text (bare-URL fallback still picks up the URL with slug-derived title)', () => {
    // The anchor-pattern filter rejects titles <5 or >200 chars. But Pattern 3 (bare URL
    // recognition) runs unconditionally and catches the URLs with a slug-derived title.
    // So the net count is 2, not 0 — and that's the intentional resilience: a malformed
    // teaser anchor shouldn't drop a legitimate article.
    const html = `
      <a href="${REAL_ARTICLE_URLS.beaches}">Hi</a>
      <a href="${REAL_ARTICLE_URLS.burnoutPara}">${'X'.repeat(250)}</a>
    `;
    const articles = extractArticlesFromCategoryPage(html);
    assert.strictEqual(articles.length, 2);
    const urls = articles.map(a => a.url).sort();
    assert.ok(urls.includes(REAL_ARTICLE_URLS.beaches));
    assert.ok(urls.includes(REAL_ARTICLE_URLS.burnoutPara));
    // Bare-URL fallback derives its title from the slug, which is long — assert we got
    // a reasonable derived title (title-cased) for each.
    for (const a of articles) {
      assert.ok(a.title && a.title.length > 0, `expected a non-empty title, got ${JSON.stringify(a.title)}`);
    }
  });

  it('handles Markdown-encoded [Title](url) links', () => {
    const md = `[Did The Reviews Go Wild](${REAL_ARTICLE_URLS.wildParty}) is worth reading.`;
    const articles = extractArticlesFromCategoryPage(md);
    assert.strictEqual(articles.length, 1);
    assert.strictEqual(articles[0].url, REAL_ARTICLE_URLS.wildParty);
    assert.strictEqual(articles[0].title, 'Did The Reviews Go Wild');
  });

  it('falls back to bare URL recognition when no link wrapper present', () => {
    const plain = `Text with ${REAL_ARTICLE_URLS.fiddler} embedded.`;
    const articles = extractArticlesFromCategoryPage(plain);
    assert.strictEqual(articles.length, 1);
    assert.strictEqual(articles[0].url, REAL_ARTICLE_URLS.fiddler);
  });
});

describe('searchPlaybillVerdict — per-show matching', () => {
  it('returns the matching article URL for the opening-night show (real Beaches article title)', async () => {
    // This is the actual Playbill Verdict article title for Beaches 2026-04-22,
    // verified against data/review-texts/beaches-2026/playbill--unknown.json:
    //   url = https://playbill.com/article/reviews-what-do-the-critics-think-of-beaches-on-broadway
    // matchTitleToShow returns confidence=medium for this (batch script rejects medium
    // to avoid 700-show fan-out false positives; per-show query accepts it safely).
    const categoryHtml = `
      <a href="${REAL_ARTICLE_URLS.beaches}">Reviews: What Do the Critics Think of Beaches on Broadway?</a>
      <a href="${REAL_ARTICLE_URLS.burnoutPara}">Read the Reviews for Pony Cam's Burnout Paradise Off-Broadway</a>
    `;
    const show = { id: 'beaches-2026', title: 'Beaches, A New Musical', slug: 'beaches-2026', category: 'broadway', openingDate: '2026-04-22' };
    const hit = await searchPlaybillVerdict(show, { fetchHtml: async () => categoryHtml });
    assert.ok(hit, 'expected a match for Beaches');
    assert.strictEqual(hit.articleUrl, REAL_ARTICLE_URLS.beaches);
  });

  it('returns the matching article URL for the classic "The Verdict: {Title}" encoding', async () => {
    // Playbill has used multiple title formats historically. The shortest/cleanest
    // variant — "The Verdict: {Show Title}" — is what matchTitleToShow handles best.
    // Longer variants like "The Verdict: Read Reviews for the Broadway Revival of X"
    // may still fall to zero matches; that's a matchTitleToShow limitation, not a
    // bug in this lib.
    const categoryHtml = `<a href="${REAL_ARTICLE_URLS.fiddler}">The Verdict: Fiddler on the Roof</a>`;
    const show = { id: 'fiddler-on-the-roof-2015', title: 'Fiddler on the Roof', slug: 'fiddler-on-the-roof-2015', category: 'broadway', openingDate: '2015-12-20' };
    const hit = await searchPlaybillVerdict(show, { fetchHtml: async () => categoryHtml });
    assert.ok(hit, 'expected a match for Fiddler');
    assert.strictEqual(hit.articleUrl, REAL_ARTICLE_URLS.fiddler);
  });

  it('matches a roundup titled with the press title (BRO-6872: Billy Crystal 860)', async () => {
    // The real Playbill title. Neither matchSlugToShow nor matchTitleToShow takes it, so the opening-night lane never
    // opened the roundup and missed Cititour, which it cited.
    const url860 = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-billy-crystals-solo-show-860-on-broadway';
    const categoryHtml = `
      <a href="${REAL_ARTICLE_URLS.burnoutPara}">Read the Reviews for Pony Cam's Burnout Paradise Off-Broadway</a>
      <a href="${url860}">Reviews: What Do the Critics Think of Billy Crystal’s Solo Show 860 on Broadway?</a>
    `;
    const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'], slug: 'billy-crystal-860', category: 'broadway', openingDate: '2026-10-21' };
    const hit = await searchPlaybillVerdict(show, { fetchHtml: async () => categoryHtml, skipSitemap: true });
    assert.ok(hit, 'expected a match for 860');
    assert.strictEqual(hit.articleUrl, url860);
    // A short press title alone, with no listing-title word, is not this show.
    const decoy = `<a href="https://playbill.com/article/reviews-860-sneakers">Reviews: What Do the Critics Think of New Balance 860?</a>`;
    assert.strictEqual(await searchPlaybillVerdict(show, { fetchHtml: async () => decoy, skipSitemap: true }), null);
  });

  it('tries press titles only after the strict sitemap pass (BRO-6872 review)', async () => {
    const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'], slug: 'billy-crystal-860', category: 'broadway', openingDate: '2026-10-21' };
    const loose = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-billy-crystals-solo-show-860-on-broadway';
    const strict = 'https://playbill.com/article/read-the-reviews-for-billy-crystal-860';
    const sitemap = `<urlset><url><loc>${strict}</loc><lastmod>2026-10-22T03:00:00Z</lastmod></url></urlset>`;
    const fetchHtml = async (u) => (u === VERDICT_SITEMAP_URL ? sitemap : `<a href="${loose}">Reviews: What Do the Critics Think of Billy Crystal’s Solo Show 860 on Broadway?</a>`);
    assert.strictEqual((await searchPlaybillVerdict(show, { fetchHtml })).articleUrl, strict);
    // With no strict hit anywhere, the press-title hit on the category page is used.
    const none = async (u) => (u === VERDICT_SITEMAP_URL ? '<urlset></urlset>' : await fetchHtml(u));
    assert.strictEqual((await searchPlaybillVerdict(show, { fetchHtml: none })).articleUrl, loose);
  });

  it('press-title pass skips a sitemap roundup from before this production (BRO-6872 review)', async () => {
    const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'], slug: 'billy-crystal-860', category: 'broadway', openingDate: '2026-10-21' };
    const old = 'https://playbill.com/article/reviews-what-do-the-critics-think-of-billy-crystals-solo-show-860-on-broadway';
    const sitemap = `<urlset><url><loc>${old}</loc><lastmod>2017-03-01T03:00:00Z</lastmod></url></urlset>`;
    const fetchHtml = async (u) => (u === VERDICT_SITEMAP_URL ? sitemap : '');
    assert.strictEqual(await searchPlaybillVerdict(show, { fetchHtml }), null);
  });

  it('press-title pass does not reuse the loose listing-title test (BRO-6872 review: The Hairy Ape)', async () => {
    const show = { id: 'the-hairy-ape-irish-repertory-theatre-off-broadway-2026', title: 'The Hairy Ape', akaTitles: ['The Hairy Ape (Irish Repertory Theatre)'], slug: 'the-hairy-ape', category: 'off-broadway', openingDate: '2026-10-28' };
    const armory = `<a href="https://playbill.com/article/park-avenue-armory-revival-critics-roundup">Reviews: What Do Critics Think of The Hairy Ape at Park Avenue Armory?</a>`;
    assert.strictEqual(await searchPlaybillVerdict(show, { fetchHtml: async () => armory, skipSitemap: true }), null);
    const caseOnly = { id: 'los-soles-truncos-off-broadway-2025', title: 'Los soles truncos', akaTitles: ['Los Soles Truncos'], slug: 'los-soles-truncos', category: 'off-broadway', openingDate: '2025-06-01' };
    const other = `<a href="https://playbill.com/article/reviews-los-soles-truncos-in-puerto-rico">Reviews: What Do Critics Think of Los Soles Truncos in San Juan?</a>`;
    const r = await searchPlaybillVerdict(caseOnly, { fetchHtml: async () => other, skipSitemap: true });
    assert.ok(r === null || /los-soles-truncos/.test(r.articleUrl), 'a case-only aka adds no second, looser pass');
  });

  it('returns null when no article matches the show', async () => {
    const categoryHtml = `<a href="${REAL_ARTICLE_URLS.burnoutPara}">Burnout Paradise Off-Broadway</a>`;
    const show = { id: 'hamilton', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06' };
    const hit = await searchPlaybillVerdict(show, { fetchHtml: async () => categoryHtml });
    assert.strictEqual(hit, null);
  });

  it('returns null when the category page is empty / unfetchable', async () => {
    const show = { id: 'beaches-2026', title: 'Beaches, A New Musical', category: 'broadway', openingDate: '2026-04-22' };
    const hit = await searchPlaybillVerdict(show, { fetchHtml: async () => '' });
    assert.strictEqual(hit, null);
  });

  it('returns null on a show record with no title (defensive)', async () => {
    const hit = await searchPlaybillVerdict(
      { id: 'nope' },
      { fetchHtml: async () => `<a href="${REAL_ARTICLE_URLS.beaches}">Beaches review</a>` }
    );
    assert.strictEqual(hit, null);
  });
});

describe('extractReviewLinksFromArticle — blocklist behavior', () => {
  it('extracts real outbound review links', () => {
    const html = `
      <article>
        <a href="https://www.nytimes.com/2026/04/22/theater/beaches-review.html">New York Times review</a>
        <a href="https://variety.com/2026/legit/reviews/beaches-broadway-review">Variety review</a>
      </article>
    `;
    const reviews = extractReviewLinksFromArticle(html, 'beaches-2026');
    assert.ok(reviews.length >= 2);
    const domains = reviews.map(r => r.outletDomain).sort();
    assert.ok(domains.includes('nytimes.com'));
    assert.ok(domains.includes('variety.com'));
  });

  it('drops social, ticketing, and internal Playbill links', () => {
    const html = `
      <article>
        <a href="https://www.nytimes.com/2026/04/22/theater/beaches-review.html">NYT</a>
        <a href="https://www.facebook.com/playbill">Facebook</a>
        <a href="https://www.ticketmaster.com/event/123">Tickets</a>
        <a href="https://playbill.com/other-article">Related</a>
      </article>
    `;
    const reviews = extractReviewLinksFromArticle(html, 'beaches-2026');
    const domains = reviews.map(r => r.outletDomain);
    assert.ok(domains.includes('nytimes.com'));
    assert.ok(!domains.includes('facebook.com'));
    assert.ok(!domains.includes('ticketmaster.com'));
    assert.ok(!domains.includes('playbill.com'));
  });

  it('extracts parenthetical critic names from surrounding text', () => {
    const html = `
      <article>
        <p>The Times (Nancy Durrant) <a href="https://www.thetimes.com/culture/theatre/article/beaches-review-1234">liked it</a></p>
      </article>
    `;
    const reviews = extractReviewLinksFromArticle(html, 'beaches-2026');
    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0].critic, 'Nancy Durrant');
  });

  it('returns empty array when the article has no review links', () => {
    const reviews = extractReviewLinksFromArticle('<article>no links here</article>', 'beaches-2026');
    assert.deepStrictEqual(reviews, []);
  });
});

// #1647 — the batch category-page discovery path used to remove a show from
// its "still needs Google fallback" set as soon as an article TENTATIVELY
// matched its title, before fetch/page validation ran. A show whose only
// match that run later failed validation (wrong-market page, fetch error,
// LLM wrong-show rejection) would silently lose its only discovery attempt,
// since it was already gone from the pending set by the time Google
// fallback checked it. createFallbackTracker fixes this: a show stays
// pending until confirmMatch() is called, which the caller must only do
// after validation succeeds.
describe('createFallbackTracker — Google-fallback eligibility (#1647)', () => {
  it('keeps a show eligible for fallback when its match is never confirmed (validation failure case)', () => {
    const tracker = createFallbackTracker(['hamilton', 'wicked']);
    // Simulates: article tentatively matched "hamilton", but its fetched
    // page later failed Broadway-market validation, so confirmMatch() is
    // never called for it.
    assert.strictEqual(tracker.needsFallback('hamilton'), true);
    assert.deepStrictEqual(tracker.pendingIds().sort(), ['hamilton', 'wicked']);
  });

  it('removes a show from fallback eligibility only once confirmMatch() is called', () => {
    const tracker = createFallbackTracker(['hamilton', 'wicked']);
    assert.strictEqual(tracker.needsFallback('hamilton'), true);
    tracker.confirmMatch('hamilton');
    assert.strictEqual(tracker.needsFallback('hamilton'), false);
    assert.strictEqual(tracker.needsFallback('wicked'), true);
    assert.deepStrictEqual(tracker.pendingIds(), ['wicked']);
  });

  it('a show not among the tracked IDs never needs fallback', () => {
    const tracker = createFallbackTracker(['hamilton']);
    assert.strictEqual(tracker.needsFallback('not-a-tracked-show'), false);
  });
});

describe('module surface', () => {
  it('exports the expected helpers + URL constant', () => {
    assert.strictEqual(typeof VERDICT_CATEGORY_URL, 'string');
    assert.ok(VERDICT_CATEGORY_URL.startsWith('https://playbill.com/'));
    assert.strictEqual(typeof extractArticlesFromCategoryPage, 'function');
    assert.strictEqual(typeof extractReviewLinksFromArticle, 'function');
    assert.strictEqual(typeof searchPlaybillVerdict, 'function');
    assert.strictEqual(typeof createFallbackTracker, 'function');
  });
});

// #1464 — the category page is a single static fetch that never runs the
// site's scroll-triggered JS, so it only ever sees the ~27-30 articles
// present on first paint. playbill.com/sitemap.xml is site-wide (articles,
// productions, venues, galleries all mixed together) so it must be filtered
// to review-roundup slugs before use.
describe('extractArticlesFromSitemap — sitemap.xml filtering', () => {
  const sitemapXml = (locs) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;

  it('keeps only /article/ URLs whose slug matches a known Verdict review-wrapper pattern', () => {
    const xml = sitemapXml([
      ['https://playbill.com/article/read-the-reviews-for-an-american-daughter-off-broadway', '2026-08-12'],
      ['https://playbill.com/article/midnight-performance-added-for-julio-torres-marina-at-little-island', '2026-08-14'],
      ['https://playbill.com/production/an-american-daughter-off-broadway-2026', '2026-08-12'],
      ['https://playbill.com/venue/some-theatre-new-york-ny', '2023-05-08'],
    ]);
    const articles = extractArticlesFromSitemap(xml);
    assert.strictEqual(articles.length, 1);
    assert.strictEqual(articles[0].slug, 'read-the-reviews-for-an-american-daughter-off-broadway');
    assert.strictEqual(articles[0].title, 'An American Daughter');
    assert.strictEqual(articles[0].publishDate, '2026-08-12');
  });

  it('matches the reviews-sound-off-on- wrapper (Death Note London)', () => {
    const xml = sitemapXml([
      ['https://playbill.com/article/reviews-sound-off-on-frank-wildhorn-manga-musical-death-note-in-london', '2026-08-12'],
    ]);
    const articles = extractArticlesFromSitemap(xml);
    assert.strictEqual(articles.length, 1);
  });

  it('dedupes repeated <loc> entries and returns [] for empty/missing input', () => {
    const xml = sitemapXml([
      ['https://playbill.com/article/read-the-reviews-for-the-winters-tale-at-free-shakespeare-in-the-park', '2026-08-12'],
      ['https://playbill.com/article/read-the-reviews-for-the-winters-tale-at-free-shakespeare-in-the-park', '2026-08-12'],
    ]);
    assert.strictEqual(extractArticlesFromSitemap(xml).length, 1);
    assert.deepStrictEqual(extractArticlesFromSitemap(''), []);
    assert.deepStrictEqual(extractArticlesFromSitemap(null), []);
  });
});

describe('sitemap accumulator — cross-day persistence', () => {
  const withTmpState = (fn) => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-sitemap-')), 'seen.json');
    try { fn(statePath); } finally { fs.rmSync(path.dirname(statePath), { recursive: true, force: true }); }
  };

  it('loadSitemapAccumulator returns [] when the state file does not exist yet', () => {
    withTmpState((statePath) => {
      assert.deepStrictEqual(loadSitemapAccumulator(statePath), []);
    });
  });

  it('accumulateSitemapArticles unions across calls, dedupes by URL, and stamps firstSeen once', () => {
    withTmpState((statePath) => {
      const first = accumulateSitemapArticles(statePath, [
        { url: 'https://playbill.com/article/a', title: 'A', slug: 'a' },
      ]);
      assert.strictEqual(first.length, 1);
      const firstSeenA = first[0].firstSeen;
      assert.strictEqual(typeof firstSeenA, 'string');

      // A comes back again (re-seen in a later sitemap fetch) alongside a new B —
      // A's firstSeen must not be overwritten, and B must be added.
      const second = accumulateSitemapArticles(statePath, [
        { url: 'https://playbill.com/article/a', title: 'A', slug: 'a' },
        { url: 'https://playbill.com/article/b', title: 'B', slug: 'b' },
      ]);
      assert.strictEqual(second.length, 2);
      assert.strictEqual(second.find(a => a.slug === 'a').firstSeen, firstSeenA);

      // Persisted to disk, not just in-memory.
      assert.strictEqual(loadSitemapAccumulator(statePath).length, 2);
    });
  });

  it('saveSitemapAccumulator/loadSitemapAccumulator round-trip, and a corrupt file degrades to []', () => {
    withTmpState((statePath) => {
      saveSitemapAccumulator(statePath, [{ url: 'https://playbill.com/article/x', title: 'X', slug: 'x' }]);
      assert.strictEqual(loadSitemapAccumulator(statePath).length, 1);
      fs.writeFileSync(statePath, 'not json');
      assert.deepStrictEqual(loadSitemapAccumulator(statePath), []);
    });
  });
});
