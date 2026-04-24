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

const require = createRequire(import.meta.url);
const {
  VERDICT_CATEGORY_URL,
  extractArticlesFromCategoryPage,
  extractReviewLinksFromArticle,
  searchPlaybillVerdict,
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

describe('module surface', () => {
  it('exports the expected helpers + URL constant', () => {
    assert.strictEqual(typeof VERDICT_CATEGORY_URL, 'string');
    assert.ok(VERDICT_CATEGORY_URL.startsWith('https://playbill.com/'));
    assert.strictEqual(typeof extractArticlesFromCategoryPage, 'function');
    assert.strictEqual(typeof extractReviewLinksFromArticle, 'function');
    assert.strictEqual(typeof searchPlaybillVerdict, 'function');
  });
});
