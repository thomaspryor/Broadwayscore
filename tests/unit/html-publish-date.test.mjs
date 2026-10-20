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
  resolvePageDateReplacement,
  htmlDateSourceFor,
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
    for (const s of ['html-page', 'html-cookies', 'html-paid', 'html-backfill', 'extracted-from-html-json-ld', 'page-date', 'human-page-verified', 'manual-correction']) {
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
  });
  test('both backfill scripts use the shared extractor', () => {
    for (const f of ['scripts/backfill-review-dates.js', 'scripts/backfill-network-tier-dates.js']) {
      const s = src(f);
      assert.match(s, /require\('\.\/lib\/html-publish-date'\)/, f);
      assert.doesNotMatch(s, /function extractPublishDateFromHtml\(/, f);
    }
    assert.match(src('scripts/backfill-review-dates.js'), /isDateRecheckCandidate\(data, showById\.get\(show\)\)/); // BRO-5769: live predicate via the shared selector
  });
});

const PAD2 = `<p>${'The cast is strong and the staging is sharp. '.repeat(10)}</p>`;

describe('extractPublishDateFromHtml: wrong-date traps (BRO-5674 ship-check)', () => {
  const url = 'https://example.com/review';

  test('site header "today" date is the fetch date, not the publish date', () => {
    const html = `<html><body><header class="site-header"><span class="current-date">October 22, 2026</span></header>
<article><h1>Review</h1><div class="entry-meta"><span class="posted-on">October 19, 2026</span></div>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
  });

  test('a bare top-level <header> with a today date and no <article>', () => {
    const html = `<html><body><header><span class="today-date">October 22, 2026</span></header><div class="post">${PAD2}</div></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), null);
  });

  test('a show-info opening-date box does not win', () => {
    const html = `<html><body><article><div class="show-info"><span class="opening-date">October 18, 2026</span><span class="closing-date">January 25, 2027</span></div>
<div class="byline">By Jordan Ruben, October 20, 2026</div>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-20');
  });

  test('WordPress comment stamps are not the publish stamp', () => {
    const html = `<html><body><article>${PAD2}<p>Posted October 19, 2026</p></article>
<div id="comments" class="comments-area"><div class="comment-meta">October 30, 2026 at 3:14 pm</div><p>Great review!</p></div></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
  });

  test('"Updated: October 21, 2026 4:05 PM" is not the publish stamp', () => {
    const html = `<html><body><article><p>Updated: October 21, 2026 4:05 PM</p><p>October 19, 2026 9:00 PM</p>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
  });

  test('a teaser byline placed before the article does not win', () => {
    const html = `<html><body><div class="related-posts"><p>By Kobi Kassal on October 16, 2026</p></div>
<article><p>By Critic Name on October 19, 2026</p>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
  });

  test('a teaser before the <article> element without a teaser class does not win', () => {
    const html = `<html><body><div class="cards"><p>By Kobi Kassal on October 16, 2026</p></div>
<article><p>By Critic Name on October 19, 2026</p>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
  });

  test('"appears in print on" in article-meta gives the publish date, not the print date', () => {
    const html = `<html><body><article><div class="article-meta">A version of this article appears in print on October 26, 2026</div>
<div class="article-meta">Published October 19, 2026</div>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(html, url), '2026-10-19');
    const printOnly = `<html><body><article><div class="article-meta">A version of this article appears in print on October 26, 2026</div>${PAD2}</article></body></html>`;
    assert.equal(extractPublishDateFromHtml(printOnly, url), null);
  });

  test('two related NewsArticles in JSON-LD, no canonical match: no date (unscoped readers do not run)', () => {
    const ld = JSON.stringify([
      { '@type': 'NewsArticle', url: 'https://example.com/other-1', datePublished: '2026-10-12T10:00:00-04:00' },
      { '@type': 'NewsArticle', url: 'https://example.com/other-2', datePublished: '2026-10-14T10:00:00-04:00' },
    ]);
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><time datetime="2026-10-12">Oct 12</time>${PAD2}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/this-review'), null);
  });

  test("the page's own entity among related ones still wins", () => {
    const ld = JSON.stringify([
      { '@type': 'NewsArticle', url: 'https://example.com/other-1', datePublished: '2026-10-12T10:00:00-04:00' },
      { '@type': 'NewsArticle', url: 'https://example.com/this-review', datePublished: '2026-10-19T10:00:00-04:00' },
    ]);
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>${PAD2}</body></html>`;
    assert.equal(extractPublishDateFromHtml(html, 'https://example.com/this-review'), '2026-10-19');
  });
});

describe('resolvePageDateReplacement: divergence guard (BRO-5674 ship-check)', () => {
  test('no stored date: replace', () => {
    assert.equal(resolvePageDateReplacement({ storedDate: null, pageDate: '2026-10-19' }).replace, true);
  });
  test('within 7 days: replace (Theatrely 10-16 -> 10-19)', () => {
    assert.equal(resolvePageDateReplacement({ storedDate: '2026-10-16', pageDate: '2026-10-19' }).replace, true);
    assert.equal(resolvePageDateReplacement({ storedDate: '2026-10-12', pageDate: '2026-10-19' }).replace, true);
  });
  test('more than 7 days: keep the stored date', () => {
    const r = resolvePageDateReplacement({ storedDate: '2026-10-19', pageDate: '2026-10-30' });
    assert.equal(r.replace, false);
    assert.equal(r.divergentDays, 11);
  });
  test('the recheck sweep may replace a stored date already in doubt', () => {
    assert.equal(resolvePageDateReplacement({ storedDate: '2026-09-01', pageDate: '2026-10-19', allowDivergent: true }).replace, true);
  });
  test('no page date: nothing to replace with', () => {
    assert.equal(resolvePageDateReplacement({ storedDate: '2026-10-19', pageDate: null }).replace, false);
  });
});

describe('archived-copy dates (BRO-5674 ship-check)', () => {
  test('HTML from an archive is stored as html-archive', () => {
    assert.equal(htmlDateSourceFor('archive.org'), 'html-archive');
    assert.equal(htmlDateSourceFor('archive-today'), 'html-archive');
    assert.equal(htmlDateSourceFor('brightdata'), 'html-page');
    assert.equal(htmlDateSourceFor(undefined), 'html-page');
  });
  test('an archive date is not permanent: a live page may replace it, and the recheck still marks it', () => {
    for (const s of ['html-archive', 'html-archive-org']) {
      assert.equal(isPageDateSource(s), false, s);
      assert.equal(isReplaceableByPageDate({ publishDate: '2026-10-19', dateSource: s }), true, s);
      assert.equal(needsOpeningWindowDateRecheck({ publishDate: '2026-09-30', dateSource: s }, { openingDate: '2026-10-18' }), true, s);
    }
  });
});

describe('wiring (ship-check)', () => {
  const src = (f) => readFileSync(join(ROOT, f), 'utf8');
  test('collector guards divergence and stamps the archive source', () => {
    const s = src('scripts/collect-review-texts.js');
    assert.match(s, /resolvePageDateReplacement\(\{ storedDate: carriedPublishDate, pageDate: extractedDate \}\)/);
    assert.match(s, /data\.dateSource = htmlDateSourceFor\(method\);/);
    assert.match(s, /data\.pageDateCandidate = extractedDate;/);
    assert.doesNotMatch(s, /data\.dateSource = 'html-page';/);
  });
  test('backfill --recheck-dates guards divergence and tries the live page before archive.org', () => {
    const s = src('scripts/backfill-review-dates.js');
    assert.match(s, /allowDivergent: recheckDates && needsOpeningWindowDateRecheck\(current, showById\.get\(show\)\)/);
    assert.match(s, /recheckDates \? \[tryCookies, tryPaid, tryArchive\] : \[tryCookies, tryArchive, tryPaid\]/);
  });
});
