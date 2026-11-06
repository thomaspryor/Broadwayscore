/**
 * Time Out New York listing capsules vs real reviews (BRO-5222).
 *
 * Time Out serves both kinds at the same URL shape, /newyork/theater/<slug>
 * (407 stored full reviews live there), so a URL pattern cannot tell them
 * apart. The page can:
 *   real review  "Time Out says" then "<Kind> review by <Critic>" and a full body
 *   capsule      "Time Out says" then one paragraph signed "—<Critic>", no byline
 * A capsule signed by another critic is the wrong critic's text (once-2012:
 * signed David Cote, row credits Adam Feldman). An unsigned-byline capsule for
 * a show from 2014 on is a listing blurb, and the real review is elsewhere
 * (the-minutes-2022). Older TONY capsules ARE the published review
 * (la-bete-2010, how-to-succeed-2011), so they stay accepted.
 */
'use strict';

const { decodeHtmlEntities } = require('./text-cleaning');

const CAPSULE_MAX_WORDS = 150;
const LISTING_CAPSULE_FROM_YEAR = 2014;
const STORED_REVIEW_MIN_CHARS = 1500;

function htmlToText(html) {
  // The shared decoder covers every numeric/named entity (O&#039;Brien
  // bylines broke signature parsing, BRO-5261).
  return decodeHtmlEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

/**
 * @param {string} html - full page HTML
 * reviewBy is the raw text after "review by" (name plus the start of the body).
 * @returns {{hasTimeOutSays: boolean, reviewBy: string|null, capsuleSigner: string|null, capsuleWords: number}}
 */
function parseTimeoutPage(html) {
  const text = htmlToText(html);
  const i = text.indexOf('Time Out says');
  if (i < 0) return { hasTimeOutSays: false, reviewBy: null, capsuleSigner: null, capsuleWords: 0 };
  const after = text.slice(i + 'Time Out says'.length);
  // The byline runs straight into the body ("review by Adam Feldman Minimalism,
  // as an approach..."), so keep the raw run and match the critic as a prefix.
  // Older pages put a credits block first ("Machinal. American Airlines
  // Theatre... Machinal: Theater review by David Cote"), so look a little way in.
  const by = after.slice(0, 1500).match(/\breview by ([A-Z][\s\S]{0,60})/);
  if (by) return { hasTimeOutSays: true, reviewBy: by[1].trim(), capsuleSigner: null, capsuleWords: 0 };
  // Capsule: body up to "—Name" followed by the Details block (or end).
  const sig = after.match(/^([\s\S]{20,2500}?)\s?—\s?([A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+){1,3}?)(?=\s+(?:Details|Advertising|Event website|Address|Follow)\b|\s*$)/);
  if (!sig) {
    // Unsigned capsule: current listing pages carry a short blurb with no
    // signature and no byline, straight into the Details block (dancin-2023).
    const body = after.match(/^([\s\S]{20,2500}?)\s+Details\b/);
    const words = body ? body[1].trim().split(/\s+/).length : 0;
    return { hasTimeOutSays: true, reviewBy: null, capsuleSigner: null, capsuleWords: words };
  }
  return {
    hasTimeOutSays: true,
    reviewBy: null,
    capsuleSigner: sig[2].trim(),
    capsuleWords: sig[1].trim().split(/\s+/).length,
  };
}

/**
 * @param {object} p
 * @param {string} p.html - fetched page HTML
 * @param {string} [p.critic] - critic credited on the row
 * @param {number|null} [p.showYear] - opening year of the production
 * @returns {{verdict: 'review'|'wrong_critic'|'listing_capsule'|'unknown', reason?: string, pageCritic?: string|null}}
 */
function classifyTimeoutPage({ html, critic, showYear }) {
  const page = parseTimeoutPage(html);
  if (!page.hasTimeOutSays) return { verdict: 'unknown' };
  // An Unknown critic can't be contradicted (same skip as audit-critic-outlets.js).
  const rowCritic = /^unknown$/i.test(String(critic || '').trim()) ? '' : normName(critic);
  if (page.reviewBy) {
    if (rowCritic && !normName(page.reviewBy).startsWith(rowCritic)) {
      const shown = page.reviewBy.split(/\s+/).slice(0, 2).join(' ');
      // pageCritic: the byline of a real "review by" page, for re-crediting a row a roundup misattributed (BRO-7041).
      const pageCritic = /^[A-Z][A-Za-z'’.-]+ [A-Z][A-Za-z'’.-]+$/.test(shown) ? shown : null;
      return { verdict: 'wrong_critic', reason: `Time Out review by ${shown}, row credits ${critic}`, pageCritic };
    }
    return { verdict: 'review' };
  }
  // A signature naming another critic is the wrong critic at any length (once-2012: 296 words, signed David Cote).
  if (page.capsuleSigner && rowCritic && normName(page.capsuleSigner) !== rowCritic) {
    return { verdict: 'wrong_critic', reason: `Time Out capsule signed ${page.capsuleSigner}, row credits ${critic}` };
  }
  if (!page.capsuleWords || page.capsuleWords > CAPSULE_MAX_WORDS) return { verdict: page.capsuleSigner ? 'review' : 'unknown' };
  if (!page.capsuleSigner) {
    // No byline and no signature: a listing blurb, unless the show predates the
    // listing-page era (then nothing proves it is not the review).
    if (Number.isFinite(showYear) && showYear >= LISTING_CAPSULE_FROM_YEAR) {
      return { verdict: 'listing_capsule', reason: `Time Out unsigned listing capsule (${page.capsuleWords} words), not the review` };
    }
    return { verdict: 'unknown' };
  }
  if (Number.isFinite(showYear) && showYear >= LISTING_CAPSULE_FROM_YEAR) {
    return { verdict: 'listing_capsule', reason: `Time Out listing capsule (${page.capsuleWords} words), not the review` };
  }
  return { verdict: 'review' };
}

/**
 * True when the row already holds review text a listing capsule cannot
 * contradict: Time Out replaces a closed show's review with a blurb at the
 * same url, so a refetch finding the blurb must not discard the stored text.
 * @param {{tier?: string|null, textLength?: number, suspect?: boolean}} stored - the file's contentTier and fullText length; suspect when the file flags its text as not this url's review
 */
function keepsStoredTimeoutReview({ tier, textLength, suspect } = {}) {
  // Text flagged as not this url's review (repointed url, wrong show) says
  // nothing a capsule cannot contradict (BRO-5261).
  if (suspect) return false;
  return (tier === 'complete' || tier === 'truncated') && (textLength || 0) >= STORED_REVIEW_MIN_CHARS;
}

/** @param {string} url */
function isTimeoutUrl(url) {
  try { return /(^|\.)timeout\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

/**
 * Pre-opening listing blurb vs authored review, from the page's JSON-LD (BRO-6804).
 * Time Out serves a venue listing at the review URL shape before a show opens.
 * It carries @type Review and a "Time Out says" block, but no author/creator, and
 * datePublished and dateModified both fall before the opening date. A real review
 * names its critic (author/creator). Anything inconclusive stays "unknown" so the
 * URL remains a candidate (fail open to alerting).
 * @param {{html?:string, openingDate?:string}} args
 * @returns {{verdict:'listing_blurb'|'review'|'unknown', reason:string}}
 */
function classifyTimeoutListingBlurb({ html, openingDate } = {}) {
  if (!html || !openingDate) return { verdict: 'unknown', reason: 'no-html-or-opening-date' };
  const opening = Date.parse(openingDate);
  if (!Number.isFinite(opening)) return { verdict: 'unknown', reason: 'bad-opening-date' };
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    nodes.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b[1])); } catch { /* skip malformed block */ }
  }
  const types = (n) => [].concat(n['@type'] || []);
  const reviews = nodes.filter((n) => types(n).includes('Review'));
  if (!reviews.length) return { verdict: 'unknown', reason: 'no-review-jsonld' };
  for (const r of reviews) {
    if (r.author || r.creator || r.reviewRating) return { verdict: 'review', reason: 'authored-or-rated' };
  }
  const r = reviews[0];
  const pub = Date.parse(r.datePublished);
  const mod = Date.parse(r.dateModified || r.datePublished);
  if (!Number.isFinite(pub) || !Number.isFinite(mod)) return { verdict: 'unknown', reason: 'no-dates' };
  if (pub < opening && mod < opening) return { verdict: 'listing_blurb', reason: 'unauthored-and-pre-opening' };
  return { verdict: 'unknown', reason: 'post-opening-unauthored' };
}

module.exports = { classifyTimeoutListingBlurb, parseTimeoutPage, classifyTimeoutPage, keepsStoredTimeoutReview, isTimeoutUrl, CAPSULE_MAX_WORDS, LISTING_CAPSULE_FROM_YEAR };
