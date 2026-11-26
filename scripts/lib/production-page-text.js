'use strict';
/**
 * BRO-7833: the production's own listing page as synopsis source text.
 *
 * auto-fix-show-data.js asked the LLM for a plot from memory, then grounded it
 * against a title SERP. For a new regional or fringe work (most of the ~45
 * open shows the freshness report flagged missing_synopsis in 2026-11) the
 * model has never heard of the play, so both models replied UNKNOWN every day
 * and the high-severity row never drained. Yet discovery already stored the
 * page that describes the show: evidenceUrls holds the theatreinchicago /
 * theatreindc / theatreinla listing or the venue's own show page (cityfinder),
 * and officialUrl may be a show page. This module picks those URLs and pulls
 * their description text so the LLM writes from it and the grounding judge
 * checks against it.
 *
 * Pure apart from fetchProductionPageText's injected fetch.
 */

// Review outlets and article paths: a review describes the plot too, but it is
// a critic's copyrighted take, not the production's own description.
const REVIEW_HOSTS = [
  'theguardian.com', 'thestage.co.uk', 'broadwayworld.com', 'whatsonstage.com',
  'nytimes.com', 'timeout.com', 'variety.com', 'chicagotribune.com',
  'latimes.com', 'washingtonpost.com', 'bostonglobe.com', 'allthatdazzles.co.uk',
];
const ARTICLE_PATH_RE = /(^|[/-])(reviews?|articles?|post|news|blog)([/-]|$)/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function isReviewUrl(url) {
  const host = hostOf(url);
  if (!host) return true;
  if (REVIEW_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return true;
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return true; }
  return ARTICLE_PATH_RE.test(pathname);
}

/**
 * Candidate pages that describe this production, most specific first: the
 * discovery evidence pages, then officialUrl when it is a show page (a bare
 * venue homepage, e.g. the BRO-7437 venue fallback, describes no show).
 */
function productionPageUrls(show, max = 2) {
  if (!show) return [];
  const out = [];
  const add = (u) => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u.trim())) return;
    const url = u.trim();
    if (isReviewUrl(url) || out.includes(url)) return;
    out.push(url);
  };
  for (const u of Array.isArray(show.evidenceUrls) ? show.evidenceUrls : []) add(u);
  if (typeof show.officialUrl === 'string') {
    try {
      const p = new URL(show.officialUrl).pathname.replace(/\/+$/, '');
      if (p) add(show.officialUrl);
    } catch { /* not a URL */ }
  }
  return out.slice(0, max);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"').replace(/&mdash;|&ndash;/g, '-');
}

function clean(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The description text of a show page: meta/og/JSON-LD descriptions, then the
 * longer paragraphs of the body (scripts, styles, nav and footer removed).
 * Capped at maxChars. '' when the page holds nothing usable.
 */
function extractProductionPageText(html, maxChars = 2500) {
  const src = String(html || '');
  if (!src) return '';
  const parts = [];
  const push = (t) => {
    const c = clean(t);
    if (c.length < 40) return;
    if (parts.some(p => p.includes(c) || c.includes(p))) {
      // keep the longer of two overlapping copies (meta is often a cut-down paragraph)
      const i = parts.findIndex(p => c.includes(p));
      if (i >= 0) parts[i] = c;
      return;
    }
    parts.push(c);
  };
  for (const m of src.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    if (c) push(c[1]);
  }
  for (const m of src.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      for (const node of [].concat(j, j && j['@graph'] || [])) {
        if (node && typeof node.description === 'string') push(node.description);
      }
    } catch { /* malformed JSON-LD */ }
  }
  const body = src
    .replace(/<(script|style|noscript|nav|footer|header|form|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = clean(m[1]);
    if (t.length >= 80) push(t);
  }
  let out = '';
  for (const p of parts) {
    if (out.length + p.length + 1 > maxChars) {
      if (!out) out = p.slice(0, maxChars);
      break;
    }
    out = out ? `${out}\n${p}` : p;
  }
  return out;
}

const alnum = (x) => String(x || '').toLowerCase().replace(/&amp;/g, 'and').replace(/[^a-z0-9]+/g, '');

/** True when the page's visible text or title names the show (title of 4+ letters/digits). */
function pageNamesShow(html, show) {
  const t = alnum(show && show.title);
  if (t.length < 4 || typeof html !== 'string') return false;
  const visible = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return alnum(visible).includes(t);
}

/**
 * First candidate page that yields description text, as { url, text }, or
 * null. `fetchHtml(url)` resolves to the page HTML (fetchPage in production);
 * any fetch error just moves on to the next URL.
 */
async function fetchProductionPageText(show, fetchHtml, { maxUrls = 2 } = {}) {
  for (const url of productionPageUrls(show, maxUrls)) {
    let html;
    try { html = await fetchHtml(url); } catch { html = null; }
    // Identity: a season index or another show's page can sit in evidenceUrls. Only a page that
    // names this show may be used (and the text is told to the model as "this production's page").
    if (!pageNamesShow(html, show)) continue;
    const text = extractProductionPageText(html);
    if (text) return { url, text: text.replace(/"{3,}/g, "'") };
  }
  return null;
}

module.exports = { pageNamesShow, productionPageUrls, extractProductionPageText, fetchProductionPageText, isReviewUrl };
