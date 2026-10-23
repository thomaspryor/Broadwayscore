'use strict';
/**
 * HTML -> review body text, the extraction collect-review-texts.js uses for every fetched page (generic paragraphs /
 * JSON-LD first, dedicated per-host extractors as fallback). Moved out of collect-review-texts.js (BRO-5993) so the
 * opening-night lane extracts text the same way: the lane used article-extractor.js alone, which returned 916 of
 * Deadline's ~6,400 characters, and the scorer rejected Deadline and WSJ as body_too_short on Oct 21 and 22.
 */
const { extractArticleText: extractArticleTextFromHtml, extractZoxNewsBody, extractVarietyBody, isDedicatedExtractorHost } = require('./article-extractor');
const { chooseArticleBody, SHORT_JSONLD_MAX: JSONLD_TEASER_MAX } = require('./jsonld-body-choice');
const { extractFromJsonLd, extractParagraphText } = require('./html-article-text');
const { decodeBloxRot47 } = require('./blox-rot47-decode');

// BRO-3499: only TB and Variety delegated to article-extractor.js; the other
// DEDICATED_EXTRACTOR_HOSTS (WSJ, La Voce, The Stage, The Times, LSA, Theatre
// Weekly) ran on the generic extraction alone, leaving their tested dedicated
// patterns unused. Generic stays first (no behavior change when it already
// found a full body); the dedicated extractor is the fallback when the generic
// result is short, and wins only if it recovers more text.
const DEDICATED_FALLBACK_MIN_CHARS = 500;
function extractTextFromHtml(html, url) {
  // BLOX CMS hosts (Tulsa World, Buffalo News, ...) ship paywalled paragraphs
  // ROT47-scrambled; decode before either extractor runs (BRO-4221).
  html = decodeBloxRot47(html);
  const generic = extractTextFromHtmlGeneric(html, url);
  if (!url || generic.length >= DEDICATED_FALLBACK_MIN_CHARS || !isDedicatedExtractorHost(url)) return generic;
  let dedicated = null;
  try { dedicated = extractArticleTextFromHtml(html, url); } catch { dedicated = null; }
  return dedicated && dedicated.length > generic.length ? dedicated : generic;
}

function extractTextFromHtmlGeneric(html, url) {
  if (!html || typeof html !== 'string') return '';

  // Talkin' Broadway (BRO-912): checked FIRST (ahead of JSON-LD/generic
  // parsing) and authoritative — a "known outlet, don't let a bad fallback
  // masquerade as a real extraction" host, same as WSJ/Stage/Times in
  // scripts/lib/article-extractor.js's DEDICATED_EXTRACTOR_HOSTS. The naive
  // "grab every <p> inside <section class='page'>" scrape this used to fall
  // through to has no byline anchor, so on a "Past Reviews" page (multiple
  // runs stacked on one URL) it blends every stacked run into one fullText,
  // and it doesn't structurally exclude the newsletter-signup sidebar either
  // — the exact garbage/bleed failure modes BRO-912 reports. Delegate to the
  // shared, unit-tested byline-anchored extractor (task #1887) instead, which
  // anchors on the page's "Theatre Review by {Critic} - {Date}" marker. If it
  // returns null (no byline marker — not a real review page), return ''
  // rather than resurrecting the naive scrape: a null here means "this TB
  // page isn't a review", not "the good extractor merely failed".
  if (url && url.includes('talkinbroadway.com')) {
    return extractArticleTextFromHtml(html, url) || '';
  }

  // Nub News (BRO-5219): the generic path clears the 500-char dedicated
  // fallback threshold by keeping the donation appeal + share chrome, so the
  // dedicated extractor must run first. Falls through if its body block is
  // missing (unlike TB, a miss here doesn't mean "not a review").
  if (url && /(^|\.)nub\.news\//.test(url.replace(/^https?:\/\//, ''))) {
    const nub = extractArticleTextFromHtml(html, url);
    if (nub) return nub;
  }

  // New Yorker-specific extraction: isolate article body before generic parsing
  if (url && url.includes('newyorker.com')) {
    const nyText = extractNewYorkerFromHtml(html);
    if (nyText && nyText.length > 500) return nyText;
  }

  // Variety: the page paragraphs carry mid-article promo modules ("Related
  // Stories" headlines) and the JSON-LD body can be a teaser; the dedicated
  // extractor strips the promos (BRO-5222, Farnsworth refetch).
  if (url && url.includes('variety.com')) {
    const varietyText = extractVarietyBody(html);
    if (varietyText && varietyText.length > 500) return varietyText;
  }

  // Zox News theme (t2conline.com): body container only, never the
  // auto-loaded next stories (BRO-4977). Detected by markup, not host.
  const zoxText = extractZoxNewsBody(html);
  if (zoxText && zoxText.length > 500) return zoxText;

  // Try JSON-LD extraction — reliable when available, avoids CSS selector fragility
  const jsonLdText = extractFromJsonLd(html);
  if (jsonLdText && jsonLdText.length > 500) {
    if (jsonLdText.length >= JSONLD_TEASER_MAX) return jsonLdText;
    // A short JSON-LD body can be a teaser (Variety, BRO-5222): prefer the
    // page's paragraphs when they hold the same article, clearly longer.
    const choice = chooseArticleBody(jsonLdText, extractParagraphText(html));
    if (choice.source === 'paragraphs') {
      console.log(`    ↪ JSON-LD body is a ${jsonLdText.length}-char teaser; using ${choice.text.length} chars of page paragraphs`);
    }
    return choice.text;
  }
  return extractParagraphText(html);
}

/**
 * New Yorker-specific HTML extraction.
 * Isolates the article body container and strips recirc/newsletter/ad noise.
 * The ♦ character is New Yorker's traditional end-of-article marker.
 */
function extractNewYorkerFromHtml(html) {
  // Strip noise sections before extracting paragraphs
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Try to isolate the article body container
  const bodyContainerMatch = cleaned.match(
    /class="[^"]*body__inner-container[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  // Also try BodyWrapper pattern (Condé Nast CMS variant)
  const bodyWrapperMatch = !bodyContainerMatch && cleaned.match(
    /class="[^"]*BodyWrapper[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  const articleHtml = (bodyContainerMatch || bodyWrapperMatch)?.[1] || cleaned;

  // Remove inline newsletter, audio embeds, and ad containers within article
  const strippedHtml = articleHtml
    .replace(/<div[^>]*class="[^"]*Newsletter[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AudioEmbed[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*VideoFigure[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AdWrapper[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*consumer-marketing[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(strippedHtml)) !== null) {
    const pText = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;/g, "\u2019")
      .replace(/&lsquo;/g, "\u2018")
      .replace(/&rdquo;/g, "\u201D")
      .replace(/&ldquo;/g, "\u201C")
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for') &&
        !pText.toLowerCase().includes('newsletter')) {
      paragraphs.push(pText);
    }
  }

  let result = paragraphs.join('\n\n');

  // Truncate at ♦ (New Yorker end-of-article marker) if present
  const diamondIdx = result.indexOf('\u2666');
  if (diamondIdx > 500) {
    result = result.substring(0, diamondIdx).trim();
  }

  // Also truncate at "Published in the print edition" footer text
  const printIdx = result.indexOf('Published in the print edition');
  if (printIdx > 500) {
    result = result.substring(0, printIdx).trim();
  }

  return result;
}

module.exports = { DEDICATED_FALLBACK_MIN_CHARS, extractTextFromHtml, extractTextFromHtmlGeneric, extractNewYorkerFromHtml };
