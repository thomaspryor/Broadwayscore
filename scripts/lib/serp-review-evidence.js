/**
 * serp-review-evidence.js (BRO-5732)
 *
 * The gap audit's SERP census used to accept any URL that was not on a deny
 * list, so every new non-review shape (a photo-release news post on 24-ore.com,
 * BRO-5134) needed one more pattern in non-review-url-patterns.js. The census
 * query is "<title> review", so a genuine review nearly always says so in its
 * URL, title or snippet. Fail closed: an unregistered host is a candidate only
 * when it shows review-shaped evidence. A registered outlet keeps the old
 * deny-list-only treatment (its hosts publish reviews as a matter of course).
 */
'use strict';

const REVIEW_EVIDENCE_RE = /\breviews?\b|\breviewed\b|\breviewer\b|\bcritic'?s?\b|\b(?:recensi(?:on[ei]|e)|rezension(?:en)?|kritik|critiques?|cr[i\u00ed]ticas?|rese[n\u00f1]as?|besprechung|avis)\b|[★☆]|\b[1-5](?:\.5)?\s*(?:\/|out of)\s*5\b|\b[1-5](?:\.5)?[- ]stars?\b|\bstars?\b\s*[:–-]|\bverdict\b|\bour take\b/i;

/**
 * @param {{url?: string, link?: string, title?: string, snippet?: string}} sr raw SERP result
 * @returns {boolean} true when its url, title or snippet reads like a review
 */
function hasReviewEvidence(sr) {
  const text = `${(sr && (sr.url || sr.link)) || ''} ${(sr && sr.title) || ''} ${(sr && sr.snippet) || ''}`;
  return REVIEW_EVIDENCE_RE.test(text.replace(/[_/]+/g, ' '));
}

module.exports = { hasReviewEvidence, REVIEW_EVIDENCE_RE };
