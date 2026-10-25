'use strict';

const { isArticleOutsideProductionWindow } = require('./date-guard');

/**
 * Turn a Guardian Content API `content` object into a fetch result in the same
 * shape every scraper tier returns ({ text, html, method, attempts }), plus the
 * API's own metadata as `apiMeta`: { score, publishDate }.
 *
 * collect-review-texts.js used to return { fullText, contentTier, ... } here,
 * so the caller's `result.text.length` threw and every Guardian review failed
 * after the API had already returned its text (BRO-5851).
 *
 * `html` stays empty: the API body is a fragment with no <head>, canonical or
 * star widget, so the page-level extractors (score, date, title, walled-page
 * salvage) would read nothing or the wrong thing from it. The rating comes from
 * the API field instead, as in fetch-guardian-reviews.js, and the publish
 * date from webPublicationDate.
 *
 * Returns { result: null, reason } when the shortcut should not be used:
 * no usable body, or an article dated outside the production's window (a
 * revival's stale slug serving a prior production, the Glengarry 2017 case).
 */
/** The Europe/London calendar day of an ISO timestamp (a 00:30 BST post is that day, not the UTC day before). */
function londonDay(iso) {
  const d = new Date(iso || '');
  if (!iso || isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const ROUNDUP_HEADLINE = /\b(roundup|shows? to see|things to do|what to see|best (?:plays|musicals|shows|of)|this week|and more|top \d+|\d+ shows)\b/i;
const squash = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The html the URL→content mention check should see for a result: the page html
 * when there is one, else a bare <title> built from an API headline.
 */
function titleHtmlFor(result) {
  if (!result) return null;
  if (result.html) return result.html;
  // A roundup headline is no proof the article is about this show; withholding it
  // keeps a "shows to see" title from relaxing the body-mention threshold.
  if (!result.pageTitle || ROUNDUP_HEADLINE.test(String(result.pageTitle))) return null;
  const esc = String(result.pageTitle).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<title>${esc}</title>`;
}

/**
 * True when a Guardian API headline is a dedicated review of this show: it reads
 * "<show title> review ..." ("King Lear review – Ian McKellen ...", "Pity review – ...").
 * Out-of-window articles (a revival's stale slug) never reach this: the date
 * guard in guardianContentToResult refuses them first.
 * The API returns the article stored at the exact path, so the CDN-misroute case
 * the URL→content mention count guards against cannot occur; a critic who names a
 * one-word title only in the headline ("Translations", "Pity") is otherwise
 * rejected as url_content_mismatch (BRO-5851: 7 of 9 Guardian reviews).
 * Roundup headlines never qualify.
 */
function apiHeadlineLeadsWithShow(pageTitle, showTitle) {
  const head = squash(pageTitle);
  const title = squash(showTitle);
  if (!head || !title || ROUNDUP_HEADLINE.test(String(pageTitle))) return false;
  const variants = new Set([title, title.replace(/^the /, '')]);
  // Guardian review headlines read "<Title> review – <standfirst>"; requiring the
  // word "review" right after the title excludes interviews/features ("King Lear:
  // Ian McKellen on ...") and longer titles that begin with this one ("Pity Party").
  return [...variants].some((t) => t.length > 2 && (head === `${t} review` || head.startsWith(`${t} review `)));
}

/**
 * Whether a failed URL→content mention check may be waived for this fetch result:
 * only a Guardian API result whose own headline reads "<show title> review".
 */
function guardianMentionWaiver(result, showTitle) {
  return !!result && result.method === 'guardian-api' && apiHeadlineLeadsWithShow(result.pageTitle, showTitle);
}

function guardianContentToResult(content, { show = null } = {}) {
  const fields = content && content.fields;
  if (!fields || !(fields.bodyText || fields.body)) return { result: null, reason: 'no usable body' };
  if (show && isArticleOutsideProductionWindow(show, content.webPublicationDate)) {
    return { result: null, reason: `article dated ${content.webPublicationDate} is outside this production's window` };
  }
  let text = fields.bodyText || '';
  if (!text && fields.body) {
    text = fields.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (text.length <= 200) return { result: null, reason: 'no usable body' };
  const stars = /^[1-5]$/.test(String(fields.starRating || '').trim()) ? Number(fields.starRating) : null;
  return {
    result: {
      text,
      html: '',
      method: 'guardian-api',
      attempts: [{ tier: 0, method: 'guardian-api', success: true }],
      // The API headline stands in for the page <title> in the URL→content
      // mention check (titleHtmlFor), which otherwise sees no headline at all.
      pageTitle: content.webTitle || fields.headline || null,
      apiMeta: {
        score: stars
          ? { originalScore: `${stars}/5 stars`, normalizedScore: Math.round((stars / 5) * 100), source: 'guardian-api' }
          : null,
        publishDate: londonDay(content.webPublicationDate),
      },
    },
    reason: null,
  };
}

module.exports = { guardianContentToResult, londonDay, titleHtmlFor, apiHeadlineLeadsWithShow, guardianMentionWaiver };
