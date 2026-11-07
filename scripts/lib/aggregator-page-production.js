/**
 * aggregator-page-production.js — BRO-3121
 *
 * Does an aggregator page (an LBO review round-up or an LBO first-party review
 * post) describe the CURRENT production of the show it was matched to?
 *
 * The page-title checks (checkArchiveCategory) only prove the page names the
 * show's title. On a revived title that is not enough: on 2026-09-08 two LBO
 * posts (/news/post/jane-eyre-review, /news/post/review-jane-eyre) about the
 * Bristol Old Vic production matched jane-eyre-off-west-end-2026 (Southwark
 * Playhouse Elephant) and were written with aggregatorStars 4/5 ->
 * originalScoreNormalized 80 and no blocking flag. Excerpt-only files score
 * through that star fallback, so a prior production's rating would have been
 * the show's composite on a night with zero real reviews.
 *
 * Callers drop every row of a page dated outside the run (outOfRun: the page
 * is about another production, and even a starless excerpt would be LLM-scored
 * as this show's review). An undated page that is merely not corroborated keeps
 * its excerpts but loses the star score.
 *
 * Evidence, strongest first:
 *   1. the page's own publish date (JSON-LD datePublished, article:published_time,
 *      <time datetime>) checked with the same date guard the rebuild uses:
 *      outside the run window -> not corroborated; inside -> corroborated.
 *   2. no usable date: the show's venue named in the headline or article body.
 *   3. neither -> not corroborated (fails closed for the score only).
 */

'use strict';

const { evaluateDateGuard, earliestShowDate } = require('./date-guard');

function extractPageDateFromHtml(html) {
  if (!html || html.length < 100) return null;
  const pick = (m) => {
    if (!m) return null;
    const d = m[1].substring(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  return pick(html.match(/"datePublished"\s*:\s*"([^"]+)"/))
    || pick(html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i))
    || pick(html.match(/<time[^>]*datetime=["']([^"']+)["']/i));
}

// Words that say nothing about WHICH venue: dropped before matching.
const GENERIC_VENUE_WORDS = new Set([
  'the', 'theatre', 'theater', 'london', 'at', 'of', 'and', 'studio', 'stage', 'house',
]);

function venueTokens(venue) {
  return String(venue || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_VENUE_WORDS.has(t));
}

// The article itself, never the page chrome: LBO's nav/sidebar lists many
// West End houses, so a whole-page search "corroborates" almost any venue
// (second-opinion 2026-10-14: an undated Garrick review matched Gielgud,
// Lyceum, Palladium...). Headline + article body only; none found -> ''.
function articleText(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(String(html || ''));
  const parts = [
    $('meta[property="og:title"]').attr('content') || '',
    $('h1').first().text(),
  ];
  $('.pmain, .pctnt, article, .entry-content, .post-content').each((_, el) => { parts.push($(el).text()); });
  return pageText(parts.join(' '));
}

function pageText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * @param {{ html: string, show: object, pageDate?: string|null }} args
 * @returns {{ corroborated: boolean, reason: string, pageDate: string|null }}
 */
function checkAggregatorPageProduction({ html, show, pageDate } = {}) {
  const date = pageDate || extractPageDateFromHtml(html);
  if (date && show && earliestShowDate(show)) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      const verdict = evaluateDateGuard({ pubDate: d, show });
      if (verdict.flag) {
        return { corroborated: false, outOfRun: true, reason: `page dated ${date} is ${verdict.issue} (${verdict.diffDays}d outside the run)`, pageDate: date };
      }
      return { corroborated: true, reason: `page dated ${date} inside the run`, pageDate: date };
    }
  }
  const tokens = venueTokens(show && show.venue);
  if (tokens.length > 0) {
    const text = articleText(html);
    // Two distinctive tokens are enough ("Southwark Playhouse" for Southwark
    // Playhouse Elephant); a one-token venue (Barbican) needs that one.
    const hits = tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(text)).length;
    if (hits >= Math.min(2, tokens.length)) {
      return { corroborated: true, reason: `venue "${show.venue}" named on the page`, pageDate: date || null };
    }
    return { corroborated: false, reason: `no usable page date and venue "${show.venue}" not named on the page`, pageDate: date || null };
  }
  return { corroborated: false, reason: 'no usable page date and no venue to match', pageDate: date || null };
}

module.exports = { checkAggregatorPageProduction, extractPageDateFromHtml, venueTokens };
