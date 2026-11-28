/**
 * DOM article extractor (jsdom).
 *
 * Tests the in-browser extraction logic from scripts/lib/dom-article-extractor.js.
 * Originally lived inline inside collect-review-texts.js's `extractArticleText(page)`
 * page.evaluate callback, which made it untestable. Parallel sessions silently
 * reverted critical fixes (CHROME_SELECTORS filter, multi-match selector logic)
 * THREE times in 24 hours. Lib + tests = guard against future reverts.
 *
 * Coverage:
 * - JSON-LD articleBody preference
 * - Multi-match for broad selectors (article, main, .article-wrapper) — picks
 *   largest, defends against sidebar teaser cards
 * - CHROME_SELECTORS filter — Jetpack chrome inside entry-content gets
 *   stripped, NOT included in paragraph text
 * - Wrapper safety — exact-class CSS matching, doesn't strip elements that
 *   merely contain a chrome class as a substring (gridwp-author-bio)
 * - Fallback paragraph collection still excludes chrome subtrees
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import {
  extractArticleTextFromDocument,
  CHROME_SELECTORS,
  MULTI_MATCH_SELECTORS,
} from '../../scripts/lib/dom-article-extractor.js';

function docFromHtml(html) {
  return new JSDOM(html).window.document;
}

describe('DOM extractor: JSON-LD takes priority', () => {
  test('returns articleBody from JSON-LD when present', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      ${JSON.stringify({
        '@type': 'NewsArticle',
        articleBody: 'A real critical evaluation of the production. '.repeat(20),
      })}
      </script>
      </head><body><article><p>Different body in HTML.</p></article></body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.includes('A real critical evaluation'), 'JSON-LD body should be preferred');
    assert.ok(!text.includes('Different body in HTML'), 'should NOT use article fallback when JSON-LD has enough');
  });
});

describe('DOM extractor: multi-match for broad selectors', () => {
  test('multiple <article> tags: picks the largest by paragraph length', () => {
    const teasers = Array.from({ length: 8 }, (_, i) =>
      `<article class="group/article-teaser"><p>Teaser ${i} short blurb about something else entirely.</p></article>`
    ).join('');
    const main = `<article class="main"><p>${'Real review prose with critical analysis. '.repeat(30)}</p></article>`;
    // Teasers FIRST in DOM order. First-match logic would pick teaser #0.
    const html = `<html><body>${teasers}${main}</body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.includes('Real review prose'), `expected main article body, got: ${text.slice(0, 100)}`);
    assert.ok(!text.includes('Teaser 0'), 'teaser content should NOT appear when a larger article exists');
  });

  test('.article-wrapper is in MULTI_MATCH_SELECTORS', () => {
    assert.ok(MULTI_MATCH_SELECTORS.has('.article-wrapper'),
      'NY Sun fix requires .article-wrapper to use largest-match logic');
  });
});

describe('DOM extractor: CHROME_SELECTORS chrome stripping', () => {
  test('strips Jetpack sharedaddy + jp-relatedposts inside entry-content', () => {
    const html = `<html><body><article>
      <div class="entry-content">
        <p>${'Real review body sentence. '.repeat(30)}</p>
        <p>More critical evaluation of the production direction.</p>
        <div class="sharedaddy sd-sharing-enabled">
          <p>Reading Broadway: The Books behind the 2025-2026 Season</p>
          <p>Coming soon: Tina Turner and The Temptations</p>
        </div>
        <div class="jp-relatedposts">
          <p>You might also like: another show review</p>
        </div>
      </div>
    </article></body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.includes('Real review body'));
    assert.ok(text.includes('critical evaluation'));
    assert.ok(!text.includes('Reading Broadway'),
      `chrome leaked through: ${text.slice(-200)}`);
    assert.ok(!text.includes('Tina Turner'),
      'related-posts content leaked through');
    assert.ok(!text.includes('You might also like'),
      'jp-relatedposts content leaked through');
  });

  test('CHROME_SELECTORS contains all 11 known chrome classes', () => {
    // ⚠️ These selectors must exist. Removing any re-introduces chrome bleed.
    // Documented in feedback_url_content_mismatch_three_layers.md.
    const required = [
      '.sharedaddy', '.jp-relatedposts', '#jp-post-flair',
      '.sd-sharing', '.sd-like', '.wpcnt',
      '.related-posts', '[class*="related-posts"]',
      '.author-bio', '.post-tags', '.post-meta', '.social-share',
    ];
    for (const sel of required) {
      assert.ok(CHROME_SELECTORS.includes(sel),
        `CHROME_SELECTORS missing '${sel}' — Joe Turner Mandell 2026-04-26 incident regression`);
    }
  });

  test('does NOT match wrapper classes that only contain chrome name as substring', () => {
    // Genesis Framework concern from QA review: `.author-bio` shouldn't match
    // `gridwp-author-bio` (compound class). CSS selector semantics use exact
    // whitespace-separated class tokens.
    const html = `<html><body><article>
      <div class="gridwp-author-bio">
        <p>${'This wrapper class contains author-bio as a substring but is its own class. '.repeat(20)}</p>
      </div>
    </article></body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.includes('This wrapper class'),
      'paragraphs in gridwp-author-bio should NOT be filtered (class is not exactly author-bio)');
  });
});

describe('DOM extractor: serialization roundtrip (Playwright path)', () => {
  test('function works after .toString() + eval in isolated context', async () => {
    // collect-review-texts.js calls `page.evaluate(${fn.toString()})(document)`
    // — the function must be self-contained (no module-level closures).
    // This test simulates that path: serialize → eval in vm context with only
    // `document` available. If the function references SELECTORS or
    // CHROME_SELECTORS at module scope, this throws ReferenceError.
    const vm = await import('node:vm');
    const html = '<html><body>'
      + Array.from({ length: 8 }, (_, i) => `<article class="group/article-teaser"><p>Teaser ${i}.</p></article>`).join('')
      + `<main><div class="article-wrapper"><p>${'Real article body. '.repeat(40)}</p></div></main>`
      + '</body></html>';
    const dom = new JSDOM(html);
    const ctx = { document: dom.window.document };
    vm.createContext(ctx);
    const fnSrc = extractArticleTextFromDocument.toString();
    const result = vm.runInContext(`(${fnSrc})(document)`, ctx);
    assert.ok(result.includes('Real article body'), 'serialized fn should extract article-wrapper');
    assert.ok(!result.includes('Teaser 0'), 'serialized fn should NOT include teaser content');
  });

  test('serialized function does not reference module-level identifiers', () => {
    // If someone moves SELECTORS/MULTI_MATCH_SELECTORS/CHROME_SELECTORS back
    // to module scope, .toString() would still emit references but the
    // browser-side eval would throw. This guard fires immediately if any
    // const declaration is missing from the function body.
    const fnSrc = extractArticleTextFromDocument.toString();
    assert.ok(/const SELECTORS = \[/.test(fnSrc),
      'SELECTORS const must be declared INSIDE the function body for serialization');
    assert.ok(/const MULTI_MATCH_SELECTORS = new Set/.test(fnSrc),
      'MULTI_MATCH_SELECTORS const must be declared INSIDE the function body');
    assert.ok(/const CHROME_SELECTORS = '/.test(fnSrc),
      'CHROME_SELECTORS const must be declared INSIDE the function body');
  });
});

describe('DOM extractor: NY Sun teaser-card scenario', () => {
  test('article-wrapper inside <main> wins over 8 teaser <article> cards', () => {
    // Simulates NY Sun's actual structure: 8 sidebar teaser cards as <article>,
    // real review body in <div class="article-wrapper"> inside <main>.
    const teasers = Array.from({ length: 8 }, (_, i) =>
      `<article class="group/article-teaser"><p>Teaser ${i}: short headline about another show.</p></article>`
    ).join('');
    const html = `<html><body>
      ${teasers}
      <main>
        <div class="article-wrapper container">
          <h1>Beaches Washes Up on Broadway</h1>
          <p>${'In an interview with Bill Moyers, the late playwright described his formula. '.repeat(20)}</p>
          <p>Some final thoughts about the production direction.</p>
        </div>
      </main>
    </body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.includes('Bill Moyers'),
      `expected article-wrapper body, got: ${text.slice(0, 200)}`);
    assert.ok(!text.includes('Teaser 0'), 'teaser content leaked');
  });
});

describe('DOM extractor: talkinbroadway.com bail-out (BRO-912)', () => {
  // This DOM path's 'section.page' selector has no byline anchor and would
  // blend stacked "Past Reviews" runs together — the byline-anchored fix
  // lives in scripts/lib/article-extractor.js, which this closure-serialized
  // function can't require(). It bails out instead so a possibly-blended
  // result is never silently returned. Currently unreachable in production
  // (talkinbroadway.com is in collect-review-texts.js's knownBlockedSites,
  // which gates the Playwright tier off) — this is a defense-in-depth test.
  test('returns "" for a talkinbroadway.com URL even with plausible section.page content', () => {
    const html = `<html><body>
      <section class="page">
        <P><B>Theatre Review by <A HREF='mailto:x'>Matthew Murray</A> - October 1, 2020</B></CENTER>
        <P>${'An earlier stacked run review, describing a different cast. '.repeat(15)}
        <P><B>Theatre Review by <A HREF='mailto:y'>Howard Miller</A> - April 15, 2026</B></CENTER>
        <P>${'The current opening-night review of the show. '.repeat(15)}
      </section>
    </body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html), 'https://www.talkinbroadway.com/page/world/Foo2026.html');
    assert.strictEqual(text, '', 'should bail out rather than blend stacked runs via the naive selector');
  });

  test('no URL passed (existing call sites) still extracts normally — bail-out is opt-in via url arg', () => {
    const html = `<html><body>
      <section class="page">
        <P>${'Review prose that should still be extracted when no URL is known. '.repeat(15)}
      </section>
    </body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html));
    assert.ok(text.length > 0, 'without a url argument, extraction should proceed as before');
  });

  test('a non-talkinbroadway.com URL is unaffected', () => {
    const html = `<html><body><article><p>${'Some other outlet review text. '.repeat(15)}</p></article></body></html>`;
    const text = extractArticleTextFromDocument(docFromHtml(html), 'https://example.com/review');
    assert.ok(text.length > 0, 'non-TB URLs should extract normally');
  });
});
