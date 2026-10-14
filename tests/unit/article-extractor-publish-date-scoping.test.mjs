/**
 * extractPublishDate — main-article scoping (2026-07-11).
 *
 * Background: extractPublishDate() used to return the FIRST document-wide
 * datePublished / <time datetime> match. Aggregator + outlet pages embed
 * related-article JSON-LD (a "Related Articles" / recirculation module), so
 * when og:article:published_time was absent the first match could be a
 * DIFFERENT article's date. Two safety systems consume the result:
 *   1. gap-audit production-identity gate (a misdate marks a CURRENT article
 *      priorRun, permanently blocking its URLs from auto-ingest), and
 *   2. publishDate stamping feeding flag-wrong-production-by-date
 *      (care-west-end-2026 false flag, 2026-07-11).
 *
 * Fix: parse ALL JSON-LD blocks and prefer the article-like entity whose
 * mainEntityOfPage/url/@id matches the page's canonical URL. og:published_time
 * keeps top priority; the first-match fallback fires only when the document has
 * a single distinct candidate date.
 *
 * Fixtures mirror real page structure (see scratchpad captures of the live
 * BWW/Playbill TKAM roundups): BWW uses <link canonical>, Playbill exposes only
 * og:url, The Stage nests entities under @graph. Each fixture carries a 2026
 * main article AND a 2018 related article; the 2026 date must win.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractPublishDate } from '../../scripts/lib/article-extractor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures', 'publish-date-scoping');
const load = (name) => readFileSync(join(FIX, name), 'utf8');

describe('extractPublishDate — main-article JSON-LD scoping', () => {
  test('BWW roundup: main 2026 wins over an earlier-in-DOM related 2018 (canonical link)', () => {
    assert.equal(extractPublishDate(load('bww-roundup-2026.html')), '2026-06-30');
  });

  test('Playbill verdict: main 2026 wins over related 2018 via og:url (no canonical link)', () => {
    assert.equal(extractPublishDate(load('playbill-verdict-2026.html')), '2026-06-30');
  });

  test('The Stage: main 2026 wins over related 2018 inside @graph', () => {
    assert.equal(extractPublishDate(load('thestage-2026.html')), '2026-06-30');
  });

  test('explicit fetch URL scopes JSON-LD even when the page lists both dates', () => {
    const html = load('bww-roundup-2026.html');
    const url = 'https://www.broadwayworld.com/westend/article/Review-Roundup-TO-KILL-A-MOCKINGBIRD-West-End-2026-20260630';
    assert.equal(extractPublishDate(html, url), '2026-06-30');
  });
});

describe('extractPublishDate — priority + safety', () => {
  test('og:article:published_time still wins over any JSON-LD date', () => {
    const html =
      '<head><meta property="article:published_time" content="2026-03-01T00:00:00Z">' +
      '<link rel="canonical" href="https://x.com/a"></head><body>' +
      '<script type="application/ld+json">{"@type":"NewsArticle",' +
      '"url":"https://x.com/a","datePublished":"2019-01-01"}</script></body>';
    assert.equal(extractPublishDate(html), '2026-03-01');
  });

  test('ambiguous: two distinct related dates, no canonical/og:url, no self-URL match → null', () => {
    const html =
      '<body>' +
      '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-06-30"}</script>' +
      '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2018-12-13"}</script>' +
      '</body>';
    assert.equal(extractPublishDate(html), null);
  });

  test('single-article page (all entities agree) returns that date even without a URL match', () => {
    // Mirrors the real TKAM prior-run roundups: no og tag, one date across the page.
    const html =
      '<head><link rel="canonical" href="https://bww.com/roundup-2018"></head><body>' +
      '<script type="application/ld+json">{"@type":"Article","url":"https://bww.com/other",' +
      '"datePublished":"2018-12-13T20:34:01-05:00"}</script>' +
      '<script type="application/ld+json">{"@type":"CriticReview","datePublished":"2018-12-13T20:34:01-05:00"}</script>' +
      '</body>';
    assert.equal(extractPublishDate(html), '2018-12-13');
  });

  test('legacy fallbacks preserved: bare datePublished, <time>, publish-date div', () => {
    assert.equal(extractPublishDate('{"datePublished":"2026-04-01"}'), '2026-04-01');
    assert.equal(extractPublishDate('<time datetime="2026-02-20T12:00">Feb 20</time>'), '2026-02-20');
    assert.equal(
      extractPublishDate('<div class="publish-date">June 19, 2026 11:15 AM</div>'),
      '2026-06-19',
    );
  });

  test('empty / non-string / dateless input → null', () => {
    assert.equal(extractPublishDate(''), null);
    assert.equal(extractPublishDate(null), null);
    assert.equal(extractPublishDate('<div>no date here</div>'), null);
  });
});
