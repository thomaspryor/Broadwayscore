/**
 * dom-article-extractor.js — DOM-based article text extraction.
 *
 * Pure function that takes a Document (browser DOM or jsdom) and returns
 * extracted article text. Used by:
 *   - scripts/collect-review-texts.js (Playwright `page.evaluate`)
 *   - tests/unit/dom-article-extractor.test.mjs (jsdom)
 *
 * History: this logic lived inline inside `extractArticleText(page)` in
 * collect-review-texts.js. That made it impossible to unit-test, and
 * parallel-session merges silently reverted critical fixes (CHROME_SELECTORS
 * filter, multi-match selector logic) THREE times in 24 hours
 * (2026-04-26/27). Extracting to a lib + testing it locks the contract.
 *
 * ⚠️ DO NOT REVERT THE CHROME_SELECTORS FILTER. Removing it re-introduces
 * the newyorktheater.me Jonathan Mandell bug where related-post chrome
 * bleeds into the article body and the ensemble scoreability LLM correctly
 * rejects the page as not_a_review. See feedback_url_content_mismatch_three_layers.md.
 */

'use strict';

// Selectors searched in priority order (most specific first, generic fallback last).
const SELECTORS = [
  // New Yorker (Condé Nast) - most precise selector
  '.body__inner-container',
  // NYT
  '[data-testid="article-body"]',
  'section[name="articleBody"]',
  // Vulture / NY Mag / Condé Nast
  '[class*="ArticlePageChunks"]',
  '[class*="RawHtmlBody"]',
  // TimeOut (uses hashed class names like _articleContent_3h2iz_20)
  '[class*="_articleContent_"]',
  // Variety / THR / Deadline (PMC sites - free content)
  '.a-content',
  // WSJ
  '.article-content .wsj-snippet-body',
  'div.article-content',
  '[class*="article_body"]',
  // WaPo
  '[data-qa="article-body"]',
  '.article-body',
  // Entertainment Weekly / People
  '[data-testid="article-body-content"]',
  // Talkin' Broadway — review content in <section class="page">
  'section.page',
  // NY Sun (Next.js) — main body in `article-wrapper`. Without this the
  // generic `article` fallback below picks the first of 8 sidebar teaser
  // cards (Joe Turner 2026-04-26 incident).
  '.article-wrapper',
  // Generic (ordered by specificity)
  'article .entry-content',
  'article .post-content',
  'article .article-body',
  '.story-body',
  '.entry-content',
  '.post-content',
  '.review-content',
  '.article__body',
  '.article-content',
  '.rich-text',
  '[class*="ArticleBody"]',
  '[class*="article-body"]',
  '[class*="story-body"]',
  '[class*="StoryBody"]',
  'main article',
  '.story-content',
  '[role="article"]',
  'article',
  'main',
];

// For these broad selectors, use querySelectorAll + pick the LARGEST match
// (by paragraph count). Defends against SPAs where <article> tags are used
// for sidebar teaser cards and the first one isn't the real story.
const MULTI_MATCH_SELECTORS = new Set([
  'article', 'main', 'main article', '[role="article"]', '.article-wrapper',
]);

// Chrome blocks that frequently sit INSIDE the main article container on
// WordPress + Jetpack sites (newyorktheater.me, NYSR, etc.). Paragraphs
// inside these subtrees ("Reading Broadway: …", related-post excerpts,
// share buttons) are not part of the review and confuse the ensemble
// scoreability LLM into rejecting the page as not_a_review.
// Joe Turner Jonathan Mandell 2026-04-26 incident.
//
// ⚠️ DO NOT REMOVE OR NARROW. CHROME_SELECTORS audit (2026-04-27) confirmed
// these selectors do NOT match wrapper elements on newyorktheater.me,
// artsfuse.org, nystagereview.com — only actual chrome blocks. The
// theoretical Genesis Framework risk did not materialize.
const CHROME_SELECTORS = '.sharedaddy, .jp-relatedposts, #jp-post-flair, .sd-sharing, .sd-like, .wpcnt, .related-posts, [class*="related-posts"], .author-bio, .post-tags, .post-meta, .social-share';

/**
 * Extract article text from a Document.
 * @param {Document} document - Browser DOM or jsdom document.
 * @returns {string} Cleaned article text, or '' if no plausible body found.
 */
function extractArticleTextFromDocument(document) {
  let bestText = '';

  // Try JSON-LD first — many major sites embed articleBody in structured data
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
        for (const item of items) {
          const body = item.articleBody || item.reviewBody || item.text;
          if (body && typeof body === 'string' && body.length > bestText.length) {
            const cleaned = body.replace(/<[^>]+>/g, '').trim();
            if (cleaned.length > bestText.length) {
              bestText = cleaned;
            }
          }
        }
      } catch (e) { /* ignore parse errors per script */ }
    }
  } catch (e) { /* document.querySelectorAll can throw on detached docs */ }

  // If JSON-LD didn't give enough text, try CSS selectors
  if (bestText.length < 500) {
    for (const selector of SELECTORS) {
      try {
        // Broad selectors (article/main/etc): pick the LARGEST match.
        // First-match (querySelector) loses to sidebar teaser cards.
        const els = MULTI_MATCH_SELECTORS.has(selector)
          ? Array.from(document.querySelectorAll(selector))
          : [document.querySelector(selector)].filter(Boolean);

        let candidateText = '';
        for (const el of els) {
          // Filter out paragraphs whose closest() ancestor is a chrome block.
          // ⚠️ This is the Jetpack-chrome-strip fix — DO NOT REMOVE.
          const paragraphs = Array.from(el.querySelectorAll('p')).filter(p => !p.closest(CHROME_SELECTORS));
          const text = paragraphs.length > 0
            ? paragraphs.map(p => p.textContent.trim()).filter(t => t.length > 30).join('\n\n')
            : el.textContent.trim();
          if (text.length > candidateText.length) candidateText = text;
        }

        if (candidateText.length > bestText.length) {
          bestText = candidateText;
        }
        // Early exit: if a specific selector (not 'article' or 'main')
        // returns enough text, prefer it over broader selectors that
        // might include sidebar/related-posts content
        if (candidateText.length >= 500 && !MULTI_MATCH_SELECTORS.has(selector)) {
          break;
        }
      } catch (e) { /* selector errors are non-fatal */ }
    }
  }

  // Fallback: find all substantial paragraphs (excluding chrome subtrees)
  if (bestText.length < 500) {
    const allParagraphs = Array.from(document.querySelectorAll('p'))
      .filter(p => !p.closest(CHROME_SELECTORS));
    const contentParagraphs = allParagraphs.filter(p => {
      const text = p.textContent.trim();
      return text.length > 50 &&
        !text.toLowerCase().includes('cookie') &&
        !text.toLowerCase().includes('subscribe') &&
        !text.toLowerCase().includes('sign up') &&
        !text.toLowerCase().includes('newsletter');
    });

    if (contentParagraphs.length > 3) {
      const pText = contentParagraphs.map(p => p.textContent.trim()).join('\n\n');
      if (pText.length > bestText.length) {
        bestText = pText;
      }
    }
  }

  let cleaned = bestText
    .replace(/\s+/g, ' ')
    .replace(/Subscribe to our newsletter[^.]*\./gi, '')
    .replace(/Sign up for[^.]*\./gi, '')
    .replace(/Advertisement/gi, '')
    .trim();

  // New Yorker: truncate at ♦ end-of-article marker
  const diamondIdx = cleaned.indexOf('♦');
  if (diamondIdx > 500) {
    cleaned = cleaned.substring(0, diamondIdx).trim();
  }
  // New Yorker: truncate at print edition footer
  const printIdx = cleaned.indexOf('Published in the print edition');
  if (printIdx > 500) {
    cleaned = cleaned.substring(0, printIdx).trim();
  }

  return cleaned;
}

module.exports = {
  extractArticleTextFromDocument,
  SELECTORS,
  MULTI_MATCH_SELECTORS,
  CHROME_SELECTORS,
};
