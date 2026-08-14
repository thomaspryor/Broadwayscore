/**
 * BRO-203: article-extractor had no true generic fallback. A domain with no
 * PATTERNS entry AND no <article>/<main> wrapper returned 0 chars, so a
 * genuinely-new outlet stayed uncollectable even after ingest-review-from-url.js
 * started auto-deriving a provisional outlet for unregistered domains
 * (commit 514ed6ccd52) — extraction, not the outlet, was the real blocker.
 *
 * Covers the two new last-resort passes in extractArticleText:
 *   1. extractByCommonClass — common CMS content-container class names
 *      (entry-content, post-content, article-body, …), balanced-div matched.
 *   2. extractByParagraphDensity — collect all <p> prose once nav/header/
 *      footer/form chrome is stripped, for templates with no recognized
 *      wrapper at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: BRO-203 generic fallback for unknown domains', () => {
  test('common-class fallback: unrecognized domain using div.entry-content (no <article>)', () => {
    const html =
      '<html><body>' +
      '<nav>Home | Reviews | About</nav>' +
      '<div class="entry-content">' +
      '<p>' + 'A brand-new outlet reviewing a Broadway show for the first time. '.repeat(20) + '</p>' +
      '</div>' +
      '<footer>Copyright 2026</footer>' +
      '</body></html>';
    const text = extractArticleText(html, 'brand-new-outlet.com');
    assert.ok(text, 'should extract text via common-class fallback');
    assert.ok(text.includes('brand-new outlet reviewing'));
    assert.ok(!text.includes('Home | Reviews'), 'nav chrome should not leak in');
  });

  test('common-class fallback: nested divs inside content class do not truncate the match', () => {
    const html =
      '<html><body>' +
      '<div class="post-content">' +
      '<div class="ad-slot"><div>ad chrome</div></div>' +
      '<p>' + 'Full review prose that continues after a nested ad container. '.repeat(20) + '</p>' +
      '</div>' +
      '</body></html>';
    const text = extractArticleText(html, 'another-new-outlet.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('Full review prose'), `nested div truncated the match: ${text?.slice(0, 100)}`);
  });

  test('paragraph-density fallback: no article/main/common-class wrapper at all', () => {
    const html =
      '<html><body>' +
      '<header><nav>Home | Reviews</nav></header>' +
      '<div class="theme-wrapper">' +
      '<div class="theme-inner">' +
      '<p>' + 'This scrappy new theatre blog has its own bespoke template with no standard class names. '.repeat(10) + '</p>' +
      '<p>' + 'It still deserves to have its reviews collected instead of silently dropped. '.repeat(10) + '</p>' +
      '</div>' +
      '</div>' +
      '<footer>Subscribe to our newsletter</footer>' +
      '</body></html>';
    const text = extractArticleText(html, 'scrappy-new-blog.com');
    assert.ok(text, 'should extract text via paragraph-density fallback');
    assert.ok(text.includes('scrappy new theatre blog'));
    assert.ok(text.includes('deserves to have its reviews'));
    assert.ok(!text.includes('Home | Reviews'), 'header/nav chrome should be stripped before paragraph collection');
    assert.ok(!text.includes('Subscribe to our newsletter'), 'footer chrome should be stripped before paragraph collection');
  });

  test('returns null when there is genuinely no plausible content (nav/footer only)', () => {
    const html =
      '<html><body>' +
      '<nav>Home | Reviews | About | Contact</nav>' +
      '<footer>Copyright 2026 Some Site</footer>' +
      '</body></html>';
    const text = extractArticleText(html, 'empty-shell.com');
    assert.strictEqual(text, null, 'should not fabricate content from chrome alone');
  });

  test('paywall-gated domains still return null on logout, unaffected by the new fallback', () => {
    // thestage.co.uk explicitly returns before reaching the loop/fallbacks —
    // regression guard so the new generic passes never rescue a dead session.
    const html =
      '<html><body>' +
      '<nav>Home | Reviews</nav>' +
      '<div class="paywall-notice">' +
      '<p>' + 'Subscribe now to read this review and hundreds more premium content. '.repeat(20) + '</p>' +
      '</div>' +
      '</body></html>';
    const text = extractArticleText(html, 'thestage.co.uk');
    assert.strictEqual(text, null, 'logged-out Stage HTML must still return null');
  });
});
