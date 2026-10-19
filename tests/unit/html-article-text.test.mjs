import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFromJsonLd, extractParagraphText } = require('../../scripts/lib/html-article-text.js');
const { extractTextFromHtml: wayback } = require('../../scripts/recover-wayback-reviews.js');
const { extractTextFromHtml: collector } = require('../../scripts/collect-review-texts.js');
const { extractTextFromHtml: loginPage } = require('../../scripts/recover-login-page-reviews.js');

const paragraph = label => `<p>${label}: ${'The cast brings this scene to life. '.repeat(12)}</p>`;
const ld = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

describe('shared paragraph extraction (BRO-5244)', () => {
  for (const cls of ['article-body', 'story-body', 'entry-content', 'post-content', 'review-body']) {
    it(`keeps prose after nested divs in ${cls}`, () => {
      const html = `<article><div class="${cls}">${paragraph('Opening')}<div>${paragraph('Nested')}</div>${paragraph('Ending')}</div></article>`;
      const shared = extractParagraphText(html);
      assert.match(shared, /Opening:/);
      assert.match(shared, /Nested:/);
      assert.match(shared, /Ending:/);
      assert.equal(wayback(html, 'https://example.com/review'), shared);
      assert.equal(collector(html, 'https://example.com/review'), shared);
      assert.equal(loginPage(html, 'https://example.com/review'), shared);
    });
  }

  it('keeps prose after an inline related widget and stops at the article close', () => {
    const html = `<article><div class='entry-content'>${paragraph('Opening')}<div class="jnews_inline_related_post_wrapper"><div><article>${paragraph('Promotion')}</article></div></div><div>${paragraph('Nested')}</div>${paragraph('Ending')}</div></article><article>${paragraph('Another review')}</article>`;
    const text = extractParagraphText(html);
    assert.match(text, /Opening:/);
    assert.match(text, /Nested:/);
    assert.match(text, /Ending:/);
    assert.doesNotMatch(text, /Promotion|Another review/);
    assert.equal(wayback(html), text);
  });

  for (const wrapper of ['article', 'section class="page"', 'div itemprop="articleBody"']) {
    it(`scopes ${wrapper} without a body class`, () => {
      const tag = wrapper.split(' ')[0];
      const html = `${paragraph('Outside')}<${wrapper}>${paragraph('Opening')}<div>${paragraph('Nested')}</div>${paragraph('Ending')}</${tag}>${paragraph('After')}`;
      const text = extractParagraphText(html);
      assert.match(text, /Ending:/);
      assert.doesNotMatch(text, /Outside|After/);
      assert.equal(wayback(html), text);
    });
  }

  it('strips sidebar, navigation and trailing blog cruft', () => {
    const html = `<nav>${paragraph('Navigation')}</nav><article><div class="entry-content">${paragraph('Opening')}<div class="sidebar">${paragraph('Sidebar')}</div><div>${paragraph('Nested')}</div>${paragraph('Ending')}<p>Share this: ${'social links '.repeat(8)}</p></div></article><footer>${paragraph('Footer')}</footer>`;
    const text = extractParagraphText(html);
    assert.match(text, /Ending:/);
    assert.doesNotMatch(text, /Navigation|Sidebar|Footer|Share this/);
    assert.equal(wayback(html), text);
  });
});

describe('shared JSON-LD extraction', () => {
  const body = 'The actors make the final scene unforgettable. '.repeat(30);
  for (const data of [
    { articleBody: body },
    [{ '@type': 'WebSite' }, { reviewBody: body }],
    { '@graph': [{ '@type': 'WebSite' }, { '@type': 'Review', text: body }] },
  ]) {
    it(`reads a ${Array.isArray(data) ? 'top-level array' : data['@graph'] ? 'graph' : 'bare node'}`, () => {
      const html = ld(data);
      assert.equal(extractFromJsonLd(html), body.trim());
      assert.equal(wayback(html), body.trim());
      assert.equal(collector(html), body.trim());
    });
  }

  it('ignores malformed blocks and selects the longest valid body', () => {
    assert.equal(extractFromJsonLd('<script type="application/ld+json">broken</script>' + ld({ articleBody: 'teaser' }) + ld({ articleBody: body })), body.trim());
    assert.equal(extractFromJsonLd('<html></html>'), '');
  });

  it('preserves paragraph breaks, numeric entities and literal less-than signs', () => {
    const body = '<p>The cast&#8217;s score is 3 &lt; 4.</p><p>I <3 this show.</p>';
    assert.equal(extractFromJsonLd(ld({ articleBody: body })), 'The cast’s score is 3 < 4.\n\nI <3 this show.');
  });
});

describe('Wayback preprocessing and legacy fallback', () => {
  it('removes toolbar prose before choosing paragraphs', () => {
    const html = `<!-- BEGIN WAYBACK TOOLBAR INSERT -->${paragraph('Toolbar')}<!-- END WAYBACK TOOLBAR INSERT --><article><div class="article-body">${paragraph('Opening')}<div>${paragraph('Nested')}</div>${paragraph('Ending')}</div></article>`;
    const text = wayback(html, 'https://example.com/');
    assert.doesNotMatch(text, /Toolbar/);
    assert.match(text, /Ending:/);
  });

  it('decodes ROT47 paragraphs before shared extraction', () => {
    const { rot47 } = require('../../scripts/lib/blox-rot47-decode.js');
    const plain = paragraph('The complete performance');
    const scrambled = rot47(plain).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<article>${scrambled}</article>`;
    assert.equal(wayback(html), extractParagraphText(`<article>${plain}</article>`));
  });

  it('keeps the old-style br-only review fallback', () => {
    const opening = 'Opening review prose. '.repeat(20).trim();
    const ending = 'Ending review prose. '.repeat(20).trim();
    const html = `<html><body><nav>${paragraph('Navigation')}</nav>${opening}<br><br>${ending}</body></html>`;
    assert.equal(wayback(html), `${opening}\n\n${ending}`);
  });

  it('returns empty text for missing HTML', () => {
    assert.equal(wayback(null), '');
    assert.equal(wayback(''), '');
  });
});

describe('all three pipelines agree on Variety pages (BRO-5244 acceptance)', () => {
  const url = 'https://variety.com/2009/film/awards/god-of-carnage-1200474074/';
  // Variety shape: a-content body with nested wrappers, an injected related
  // story mid-article and a teaser-length JSON-LD body.
  const html = `${ld({ articleBody: 'Teaser sentence about the production.' })}<article><div class="a-content">${paragraph('Opening')}<div><div>${paragraph('Nested')}</div></div><div class="injected-related-story">${paragraph('Promo')}</div>${paragraph('Ending')}</div></article><p>More from Variety</p>`;

  it('wayback and login recovery return at least 90% of the collector text', () => {
    const full = collector(html, url);
    assert.match(full, /Ending:/);
    assert.doesNotMatch(full, /Promo/);
    for (const extract of [wayback, loginPage]) {
      const text = extract(html, url);
      assert.ok(text.length >= 0.9 * full.length, `${text.length} < 90% of ${full.length}`);
      assert.equal(text, full);
    }
  });

  it('wayback strips the toolbar before the Variety extractor runs', () => {
    const snap = `<!-- BEGIN WAYBACK TOOLBAR INSERT -->${paragraph('Toolbar')}<!-- END WAYBACK TOOLBAR INSERT -->${html}`;
    assert.equal(wayback(snap, url), collector(html, url));
  });
});
