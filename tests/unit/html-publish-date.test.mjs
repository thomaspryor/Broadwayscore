/**
 * BRO-5674: review publish dates read from the article page, and the rules for
 * when that page date replaces a stored one.
 *
 * Real case: Other Desert Cities (Broadway 2026, opened 2026-10-18).
 *  - Theatrely stored 2026-10-16 (no dateSource); the page prints only
 *    <div class="publish-date">October 19, 2026 12:00 AM</div> and its
 *    related-post teasers read "By <name> on October 16, 2026".
 *  - Culture Sauce stored null; the page shows "October 19, 2026" by the byline.
 * Fixtures below are trimmed from the live page structure (Theatrely, Webflow)
 * and a WordPress byline (Culture Sauce).
 *
 * Uses the real functions (CLAUDE.md §15).
 * Run: node --test tests/unit/html-publish-date.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { extractPublishDateFromHtml, extractPublishDateDetailed, parseWrittenDate } = require('../../scripts/lib/html-publish-date.js');
const {
  isReplaceableByPageDate,
  isPageDateSource,
  needsOpeningWindowDateRecheck,
} = require('../../scripts/lib/publish-date-provenance.js');

const PAD = `<p>${'Lorem ipsum dolor sit amet. '.repeat(10)}</p>`;

const THEATRELY = `<!DOCTYPE html><html><head><title>A Starry, Thrilling OTHER DESERT CITIES Returns to Broadway [Review]</title></head><body>
<nav><a href="/">Theatrely</a></nav>
<div class="post-details"><div class="details-text">By</div><a class="details-text-link" href="/author/x">Critic Name</a>
<div class="details-text a">on</div><div class="publish-date">October 19, 2026 12:00 AM</div></div>
<div class="rich-text w-richtext">${PAD}</div>
<div class="related"><h2>THE FANTASTICKS</h2><div><p class="details-text">By</p><a class="details-text-link">Kobi Kassal</a><p class="details-text">on</p><p class="details-text">October 16, 2026</p></div></div>
</body></html>`;

const CULTURE_SAUCE = `<!DOCTYPE html><html><head><title>Other Desert Cities review</title></head><body>
<header class="site-header"><a href="/">Culture Sauce</a></header>
<article><h1 class="entry-title">'Other Desert Cities' Broadway Review</h1>
<div class="entry-meta"><span class="byline">By <a href="/author/jr">Jordan Ruben</a></span> <span class="posted-on">October 19, 2026</span></div>
<div class="entry-content">${PAD}<p>Through January 25, 2027 at the Booth Theatre.</p></div></article>
</body></html>`;

describe('extractPublishDateFromHtml: visible datelines (BRO-5674)', () => {
  test('Theatrely: publish-date div wins over related-post teaser dates', () => {
    assert.equal(extractPublishDateFromHtml(THEATRELY, 'https://www.theatrely.com/post/a-starry-thrilling-other-desert-cities-returns-to-broadway-review'), '2026-10-19');
  });

  test('Culture Sauce: WordPress posted-on dateline by the byline', () => {
    assert.equal(extractPublishDateFromHtml(CULTURE_SAUCE, 'https://culturesauce.com/ther-desert-cities-julia-louis-dreyfus-broadway-review/'), '2026-10-19');
  });

  test('unclassed "By <name> | October 19, 2026" byline', () => {
    const html = `<html><body><div><p>By Jordan Ruben | October 19, 2026</p>${PAD}<p>It runs through November 30, 2026.</p></div></body></html>`;
    assert.deepEqual(extractPublishDateDetailed(html, 'https://example.com/r'), { date: '2026-10-19', method: 'html-dateline-byline' });
  });

  test('a timestamped dateline with no class', () => {
    const html = `<html><body><span>October 19, 2026 9:45 PM</span>${PAD}<p>Previews began September 22, 2026.</p></body></html>`;
    assert.deepEqual(extractPublishDateDetailed(html, 'https://example.com/r'), { date: '2026-10-19', method: 'html-dateline-timestamp' });
  });

  test('Lighting & Sound America sign-off "--David Barbour (6 May 2026)"', () => {
    const html = `<html><body><p>${PAD}</p><p>Yep, we get it. --David Barbour (6 May 2026)</p><p>E-mail this story to a friend</p></body></html>`;
    assert.deepEqual(extractPublishDateDetailed(html, 'http://www.lightingandsoundamerica.com/news/story.asp?ID=-4J89Y8'), { date: '2026-05-06', method: 'html-dateline-signoff' });
  });

  test('a run date alone in body text is not a dateline', () => {
    const html = `<html><body><article>${PAD}<p>Other Desert Cities runs through January 25, 2027 at the Booth Theatre.</p></article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), null);
  });

  test('an "updated" stamp class is not the publish date', () => {
    const html = `<html><body><span class="updated-date">October 21, 2026</span>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), null);
  });
});

describe('extractPublishDateFromHtml: structured metadata', () => {
  test('JSON-LD datePublished with an explicit ET offset keeps the local date', () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2026-10-18T22:30:00-04:00"}</script></head><body>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), '2026-10-18');
  });

  test('JSON-LD in a nested @graph array', () => {
    const html = `<html><head><script type="application/ld+json">[{"@graph":[{"@type":"WebPage"},{"@type":"Article","datePublished":"2026-10-19T09:00:00-04:00"}]}]</script></head><body>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), '2026-10-19');
  });

  test('article:published_time as a UTC stamp is moved to the New York date (BRO-5499)', () => {
    const html = `<html><head><meta property="article:published_time" content="2026-10-19T02:15:00+00:00"></head><body>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), '2026-10-18');
  });

  test('<time datetime> marked as the publish date beats an earlier header <time>', () => {
    const html = `<html><body><header><time datetime="2026-10-20">Today</time></header><span class="post-date"><time class="entry-date published" datetime="2026-10-19T00:00:00-04:00">October 19, 2026</time></span>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), '2026-10-19');
  });

  test('metadata beats a visible dateline', () => {
    const html = `<html><head><meta property="article:published_time" content="2026-10-19T08:00:00-04:00"></head><body><div class="publish-date">October 16, 2026</div>${PAD}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/r'), '2026-10-19');
  });
});

describe('parseWrittenDate', () => {
  test('US, UK and abbreviated forms; rejects impossible days', () => {
    assert.equal(parseWrittenDate('October 19, 2026 12:00 AM'), '2026-10-19');
    assert.equal(parseWrittenDate('19 October 2026'), '2026-10-19');
    assert.equal(parseWrittenDate('Oct. 19 2026'), '2026-10-19');
    assert.equal(parseWrittenDate('Sept 3rd, 2026'), '2026-09-03');
    assert.equal(parseWrittenDate('February 30, 2026'), null);
  });

  test('article-extractor reads an evening dateline as the printed date on a New York machine', () => {
    // new Date('April 19, 2026 11:25 PM').toISOString() is 2026-04-20 under TZ=America/New_York.
    const { extractPublishDate } = require('../../scripts/lib/article-extractor.js');
    assert.equal(extractPublishDate('<div class="publish-date">April 19, 2026 11:25 PM</div>', 'https://www.theatrely.com/post/x'), '2026-04-19');
  });
});

describe('isReplaceableByPageDate (BRO-5674)', () => {
  const base = { publishDate: '2026-10-16' };
  test('a date with no dateSource (aggregator/poller paths) is replaceable', () => {
    assert.equal(isReplaceableByPageDate(base), true);
  });
  test('aggregator, roundup, RSS, SERP and LLM sources are replaceable', () => {
    for (const s of ['roundup-article', 'llm-scoring', 'google-news-rss', 'bww-roundup', 'dtli', 'show-score', 'serp', 'text-llm']) {
      assert.equal(isReplaceableByPageDate({ ...base, dateSource: s }), true, s);
    }
  });
  test('a page or human date is never downgraded', () => {
    for (const s of ['html-page', 'html-cookies', 'html-archive-org', 'html-paid', 'html-backfill', 'extracted-from-html-json-ld', 'page-date', 'human-page-verified', 'manual-correction']) {
      assert.equal(isPageDateSource(s), true, s);
      assert.equal(isReplaceableByPageDate({ ...base, dateSource: s }), false, s);
    }
  });
  test('URL and body-text dates keep their old rule (not replaced)', () => {
    for (const s of ['url', 'url-compact', 'text-regex', 'extracted-from-archive-timestamp']) {
      assert.equal(isReplaceableByPageDate({ ...base, dateSource: s }), false, s);
    }
  });
  test('no stored date: nothing to replace', () => {
    assert.equal(isReplaceableByPageDate({ publishDate: null }), false);
  });
});

describe('needsOpeningWindowDateRecheck (BRO-5674)', () => {
  const show = { id: 'other-desert-cities-2026', openingDate: '2026-10-18' };
  test('Theatrely 2026-10-16 is inside the 2-day grace', () => {
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-10-16' }, show), false);
  });
  test('a non-page date more than 2 days before opening is marked', () => {
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-10-15' }, show), true);
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', dateSource: 'llm-scoring' }, show), true);
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', dateSource: 'url' }, show), true);
  });
  test('a page date is trusted (real preview coverage)', () => {
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', dateSource: 'html-page' }, show), false);
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', dateSource: 'html-cookies' }, show), false);
  });
  test('human-confirmed early post and prior-run dates are not marked', () => {
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', humanReviewedEarlyPublish: true }, show), false);
    const revival = { openingDate: '2026-10-18', priorRuns: [{ openingDate: '2011-01-13', closingDate: '2012-06-17' }] };
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2011-01-14' }, revival), false);
  });
  test('no openingDate or no publishDate: not marked', () => {
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-01-01' }, { id: 'x' }), false);
    assert.equal(needsOpeningWindowDateRecheck({ publishDate: null }, show), false);
  });
});

describe('wiring', () => {
  const src = (f) => readFileSync(join(ROOT, f), 'utf8');
  test('collect-review-texts.js uses the shared extractor and the replace/recheck rules', () => {
    const s = src('scripts/collect-review-texts.js');
    assert.match(s, /require\('\.\/lib\/html-publish-date'\)/);
    assert.doesNotMatch(s, /function extractPublishDateFromHtml\(/, 'no private copy');
    assert.match(s, /isReplaceableByPageDate\(data\)/);
    assert.match(s, /needsOpeningWindowDateRecheck\(data, showMeta\)/);
    assert.match(s, /data\.dateSource = 'html-page';/);
  });
  test('both backfill scripts use the shared extractor', () => {
    for (const f of ['scripts/backfill-review-dates.js', 'scripts/backfill-network-tier-dates.js']) {
      const s = src(f);
      assert.match(s, /require\('\.\/lib\/html-publish-date'\)/, f);
      assert.doesNotMatch(s, /function extractPublishDateFromHtml\(/, f);
    }
    assert.match(src('scripts/backfill-review-dates.js'), /needsOpeningWindowDateRecheck\(data, showById\.get\(show\)\)/);
  });
});
