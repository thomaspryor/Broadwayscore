/**
 * BRO-7792: readPageByline (page-byline.js, shared with the opening-night lane, so its source is part of
 * the lane code hash and stays untouched) plus the two things collect-review-texts' Unknown-critic
 * enrichment always did: veto a name that is in the show's cast/creative team (excludeNames) and pass
 * the review's publishDate to the generic reader.
 *
 * The veto is an exact normalized-name match, as content-quality extractAuthorFromHtml applies it
 * (a Theatricalia page credits the playwright, BRO-5065). A vetoed answer falls back to the article's text byline, else null.
 */
'use strict';

const { readPageByline } = require('./page-byline');

const norm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function readPageBylineForShow({ html, text = '', url, outletId, excludeNames, publishDate } = {}) {
  const cq = require('./content-quality');
  const hasEx = Array.isArray(excludeNames) && excludeNames.length > 0;
  let res = readPageByline({ html, text, url, outletId });
  // Outlet rules and markup answered nobody: the generic reader is the only path that takes publishDate.
  if (!res.criticName && res.source !== 'outlet-rule-none' && html) {
    let generic = null;
    try { generic = cq.extractAuthorFromHtml(html, text || '', { url, outletId, excludeNames, publishDate }) || null; } catch { generic = null; }
    const bx = require('./byline-extraction');
    if (generic && !bx.isNotACriticName(generic)) res = { ...res, criticName: generic, source: 'generic' };
  }
  if (res.criticName && hasEx) {
    const ex = new Set(excludeNames.map(norm).filter(Boolean));
    if (ex.has(norm(res.criticName))) {
      // As extractAuthorFromHtml does after a veto: the text byline can still name the real critic.
      if (text) {
        try {
          const b = cq.extractByline(text, { excludeNames });
          if (b && b.found && cq.isValidAuthorName(b.name)) {
            const name = cq.cleanAuthorName(b.name);
            if (name && !ex.has(norm(name))) return { ...res, criticName: name, source: 'text-byline' };
          }
        } catch { /* fall through to null */ }
      }
      return { ...res, criticName: null, source: null };
    }
  }
  return res;
}

// The shared reader returns a name as the page prints it ("ELYSA GARDNER" on The New York Sun); the old
// enrichment path stored it in proper case. Only an ALL-CAPS name is changed.
function properCase(name) {
  if (!name || name !== name.toUpperCase() || name === name.toLowerCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'\u2019-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// BRO-8255: a sentence-final period rides along with a name taken from prose ("Michela Smith.").
// Strip it after a 2+ letter word; an initial ("J.") and Jr./Sr. keep theirs.
function stripTrailingDot(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/\s+$/, '').replace(/([A-Za-z\u00C0-\u024F'\u2019-]{2,})\.$/, (m, w) => (/^(?:Jr|Sr)$/i.test(w) ? m : w));
}

function readPageBylineForShowCased(args) {
  const res = readPageBylineForShow(args);
  return res.criticName ? { ...res, criticName: stripTrailingDot(properCase(res.criticName)) } : res;
}

/**
 * BRO-7798: the shared reader, then the high-confidence meta reader (article:author / JSON-LD Person)
 * as a fallback, except when an outlet rule said the page names nobody: for that outlet the meta tags
 * hold the posting editor (TheaterMania credits David Gordon on every review). Returns string|null.
 */
function readPageBylineWithMetaFallback({ html, text = '', url, outletId } = {}) {
  const res = readPageBylineForShowCased({ html, text, url, outletId });
  if (res.criticName) return res.criticName;
  if (res.source === 'outlet-rule-none' || !html) return null;
  const hc = require('./content-quality').extractHighConfidenceAuthor(html);
  const name = hc ? (typeof hc === 'string' ? hc : hc.name || null) : null;
  return name ? properCase(name) : null;
}

module.exports = { readPageBylineForShow: readPageBylineForShowCased, properCase, stripTrailingDot, readPageBylineWithMetaFallback };
