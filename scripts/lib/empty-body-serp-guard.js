'use strict';

/**
 * empty-body-serp-guard.js (BRO-7084, root cause of BRO-4529).
 *
 * A SERP discovery hit is written as a body-less stub and verified later by
 * the content verifier, which needs a body. With no body the verifier never
 * runs, so a Times review of a DIFFERENT show was filed against this one on
 * the strength of the SERP hit alone. When the SERP headline is known and no
 * body is attached, require a show-title token in the headline.
 *
 * Callers that do not know the SERP headline (serpTitle undefined) are not
 * judged: only a headline that was seen and does not match is refused.
 */

const { titleMatchesShow } = require('./rss-discovery');
const { isUnvettedSerpSource } = require('./unvetted-serp-sources');
const { serpResultMentionsShow } = require('./serp-show-match');

function hasBody(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * @param {{source?: string, fullText?: string, excerpt?: string, serpTitle?: string, showTitle?: string}} args
 * @returns {{ reject: boolean, reason: string|null }}
 */
function evaluateEmptyBodySerpWrite({ source, fullText, excerpt, serpTitle, showTitle, url, akaTitles }) {
  if (!isUnvettedSerpSource(source)) return { reject: false, reason: null };
  if (hasBody(fullText) || hasBody(excerpt)) return { reject: false, reason: null };
  if (typeof serpTitle !== 'string' || !serpTitle.trim()) return { reject: false, reason: null };
  if (!showTitle) return { reject: false, reason: null };
  // Same acceptance breadth discovery used: canonical title, the part before a
  // colon/dash subtitle, declared aka titles, or the show named in the URL slug
  // ("Les Mis", "Sweeney Todd" for "Sweeney Todd: The Demon Barber...").
  const forms = [showTitle, showTitle.split(/\s*[:\u2013-]\s+/)[0], ...(Array.isArray(akaTitles) ? akaTitles : [])].filter(Boolean);
  if (forms.some(t => titleMatchesShow(serpTitle, t, { fuzzy: true }))) return { reject: false, reason: null };
  if (serpResultMentionsShow(serpTitle, url || '', showTitle)) return { reject: false, reason: null };
  return {
    reject: true,
    reason: `empty-body SERP hit whose headline ${JSON.stringify(serpTitle.slice(0, 80))} does not name "${showTitle}"`,
  };
}

module.exports = { evaluateEmptyBodySerpWrite };
