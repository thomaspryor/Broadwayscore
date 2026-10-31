'use strict';

/**
 * relative-review-url.js: classify a review file's non-absolute `url` and propose the
 * deterministic repair when one exists (BRO-5075). Pure, no fs, so the audit and its
 * test share one decision.
 *
 * Categories:
 *   ok            absolute http(s) url (or empty)
 *   bww-relative  /<region>/article/... or /article/... on a BroadwayWorld file: prefix the host
 *   typo          leading space, "hhttp://", "ttps://": strip back to the real scheme
 *   schemeless    "www.x.com/..." or "variety.com/...": prefix https://
 *   people        /people/<critic> profile page, not an article: needs a per-review lookup
 *   dotdot        ../reviews/... saved-page path: needs a per-review lookup
 *   other         a text fragment or path with no recoverable url: needs a per-review lookup
 */

const BWW_HOST = 'https://www.broadwayworld.com';

function classifyRelativeUrl(url, outletId) {
  if (typeof url !== 'string' || !url.trim()) return { category: 'ok' };
  if (/^https?:\/\//i.test(url)) return { category: 'ok' };
  const t = url.trim();
  if (/^https?:\/\//i.test(t)) return { category: 'typo', fixedUrl: t };
  const typo = t.match(/^h{2,}(ttps?:\/\/.*)$/i) || t.match(/^(ttps?:\/\/.*)$/i);
  if (typo) return { category: 'typo', fixedUrl: `h${typo[1].replace(/^h+/i, '')}` };
  if (/^\/people\//.test(t)) return { category: 'people' };
  if (/^\/(?:[a-z-]+\/)?article\//i.test(t) && outletId === 'broadwayworld') return { category: 'bww-relative', fixedUrl: `${BWW_HOST}${t}` };
  if (/^\.\.?\//.test(t)) return { category: 'dotdot' };
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s]+$/i.test(t)) return { category: 'schemeless', fixedUrl: `https://${t}` };
  return { category: 'other' };
}

module.exports = { classifyRelativeUrl, BWW_HOST };
