'use strict';

/**
 * walled-page-meta.js — salvage the public metadata of a registration-walled
 * review page.
 *
 * The Stage (thestage.co.uk) serves every review behind a free-account wall
 * when our session cookies are dead, which is most of the time since 2026-08.
 * The collector then classifies the page as garbage/paywall and saves NOTHING,
 * so the review goes live as a star rating with no date, no critic and no
 * quote (reader report 2026-09-26: Man to Man, Darkling, Deep Heat Rivalry).
 * But the walled page still carries, above the wall, in stable markup:
 *
 *   <h1 class="aos-ArticleTitle ...">Darkling review</h1>
 *   <div class="aos-StarRating ...">(5x stageStar/stageNoStar img)</div>
 *   <a class="aos-ArticleAuthor ..." title="Holly O'Mahony">by Holly O'Mahony</a>
 *   <span class="aos-ArticleDate ...">Sep 16, 2026</span>
 *   <div class="aos-DS32-Teaser ...">Evocative coming-of-age monologue ...</div>
 *     (or, on the other template, <div class="aos-Article-IntroText ...">)
 *
 * The FIRST occurrence of each is the article's own (related-article cards
 * further down reuse the ArticleAuthor/ArticleDate classes).
 *
 * applyWalledPageMeta() only FILLS gaps: it never overwrites an existing
 * publishDate, a named critic, or a manual critic, so a page that later
 * yields full text keeps whatever the full collection wrote.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function _decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _isoFromStageDate(s) {
  const m = String(s || '').match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})$/i);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const d = Number(m[2]);
  if (!mo || d < 1 || d > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isTheStageUrl(url) {
  return /^https?:\/\/(?:www\.)?thestage\.co\.uk\//i.test(String(url || ''));
}

/**
 * Extract the article's own metadata from a The Stage page (walled or not).
 * Returns null unless the page looks like a The Stage article (has the
 * ArticleTitle h1). Individual fields are null when absent.
 */
function extractTheStageArticleMeta(html) {
  if (!html || typeof html !== 'string') return null;
  const h1 = html.match(/<h1[^>]*class="[^"]*aos-ArticleTitle[^"]*"[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  if (!h1) return null;
  const headline = _decode(h1[1]) || null;

  const author = html.match(/<a[^>]*class="[^"]*aos-ArticleAuthor[^"]*"[^>]*>([\s\S]{1,120}?)<\/a>/i);
  let criticName = author ? _decode(author[1]).replace(/^by\s+/i, '').trim() : null;
  if (criticName && (criticName.length > 60 || /the stage/i.test(criticName))) criticName = null;

  const date = html.match(/<span[^>]*class="[^"]*aos-ArticleDate[^"]*"[^>]*>\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*</i);
  const publishDate = date ? _isoFromStageDate(date[1]) : null;

  // Two article templates: "aos-DS32-Teaser" (e.g. Darkling) and
  // "aos-Article-IntroText" wrapping <span><p>…</p></span> (e.g. Man to Man).
  const teaser = html.match(/<div[^>]*class="[^"]*aos-(?:DS32-Teaser|Article-IntroText)[^"]*"[^>]*>([\s\S]{1,600}?)<\/div>/i);
  const standfirst = teaser ? (_decode(teaser[1]) || null) : null;

  return { headline, criticName, publishDate, standfirst };
}

/**
 * Does the article headline name the show? False only on a confident
 * mismatch (headline present, show has distinctive tokens, none appear), so
 * callers fail open when either side is missing.
 */
function headlineMatchesShow(headline, showTitle) {
  if (!headline || !showTitle) return true;
  const { titleTokens } = require('./show-match-verifier');
  const tTokens = titleTokens(showTitle);
  if (!tTokens.length) return true;
  const h = headline.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ');
  const hTokens = new Set(h.split(' '));
  const squashed = h.replace(/ /g, '');
  return tTokens.some((t) => hTokens.has(t) || squashed.includes(t));
}

/**
 * Fill gaps on a review record from walled-page metadata. Mutates `data`;
 * returns the list of fields it set (empty when nothing changed).
 * With opts.showTitle, refuses (returns ['wrongShowSuspect']) when the page
 * headline names a different show: a date and byline must not make another
 * show's review look more legitimate.
 */
function applyWalledPageMeta(data, html, opts = {}) {
  if (!data || !isTheStageUrl(data.url)) return [];
  const meta = extractTheStageArticleMeta(html);
  if (!meta) return [];
  if (opts.showTitle && !headlineMatchesShow(meta.headline, opts.showTitle)) {
    return ['wrongShowSuspect'];
  }
  const set = [];
  if (meta.publishDate && !data.publishDate) {
    data.publishDate = meta.publishDate;
    data.publishDateSource = 'thestage-walled-page';
    set.push('publishDate');
  }
  const critic = String(data.criticName || '').trim();
  const criticIsPlaceholder = !critic || /^(unknown|the stage)$/i.test(critic);
  if (meta.criticName && criticIsPlaceholder && !data.criticNameManual) {
    data.criticName = meta.criticName;
    data.criticNameSource = 'thestage-walled-page';
    set.push('criticName');
  }
  if (meta.standfirst && meta.standfirst.length >= 25 && !data.outletStandfirst) {
    data.outletStandfirst = meta.standfirst;
    set.push('outletStandfirst');
  }
  if (meta.headline && !data.outletHeadline) {
    data.outletHeadline = meta.headline;
    set.push('outletHeadline');
  }
  if (set.length) data.walledPageMetaAt = new Date().toISOString();
  return set;
}

module.exports = { extractTheStageArticleMeta, applyWalledPageMeta, headlineMatchesShow, isTheStageUrl, _isoFromStageDate };
