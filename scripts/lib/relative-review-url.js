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
 *   doubled       an absolute url repeated after itself: keep the first copy (BRO-6981)
 *   people        /people/<critic> profile page, not an article: needs a per-review lookup
 *   dotdot        ../reviews/... saved-page path: needs a per-review lookup
 *   other         a text fragment or path with no recoverable url: needs a per-review lookup
 */

const BWW_HOST = 'https://www.broadwayworld.com';

/**
 * BRO-6981: an absolute url glued to copies of itself ("https://x.com/a/https://x.com/a/",
 * nytimes "...?ref=theaterhttp://...?ref=theater"). Returns the first copy when every later
 * segment is the same url (scheme and www ignored) or a cut-off start of it, else null.
 * A url that merely carries another url (a Wayback capture, a ?url= redirect) is not one:
 * its later segment is a different address, not a prefix of the first.
 */
function collapseRepeatedUrl(url) {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  const parts = t.split(/(?=https?:\/\/)/i).filter(Boolean);
  if (parts.length < 2 || !/^https?:\/\//i.test(parts[0])) return null;
  const norm = (s) => s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const first = norm(parts[0]);
  if (!first.includes('/')) return null;
  let sawRepeat = false;
  for (const p of parts.slice(1)) {
    const n = norm(p);
    if (n && !first.startsWith(n)) return null;
    if (n.length >= 10) sawRepeat = true;
  }
  return sawRepeat ? parts[0] : null;
}

function classifyRelativeUrl(url, outletId) {
  if (typeof url !== 'string' || !url.trim()) return { category: 'ok' };
  const doubled = collapseRepeatedUrl(url);
  if (doubled) return { category: 'doubled', fixedUrl: doubled };
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

module.exports = { classifyRelativeUrl, collapseRepeatedUrl, BWW_HOST };
