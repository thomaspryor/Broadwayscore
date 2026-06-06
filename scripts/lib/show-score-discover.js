/**
 * Show Score per-show review discovery for the gap-audit reconciliation.
 *
 * Show Score lists critic reviews (with direct outlet links) on each show's page —
 * including off-Broadway, where it lands later and with fewer reviews than Playbill
 * or BroadwayWorld, but it DOES carry them (operator note, 2026-06-06). Unlike DTLI
 * (Broadway-only), Show Score covers OB. Adding it as a reconciliation source means
 * the hourly gap audit eventually catches a review that surfaced only on Show Score.
 *
 * Show Score server-renders only the first 8 critic reviews; the rest load via its
 * pagination endpoint /shows/{slug}/paginate_critic_reviews?page=N (JSON {"html":…}).
 * We must paginate or we miss reviews 9..N (e.g. The Receptionist has 13). The
 * "Read more" links on each tile are the canonical outlet review URLs and are
 * show-page-vouched, so the caller should NOT title-match them — that lets opaque
 * outlet URLs through (Lighting & Sound America uses story.asp?ID=… with no title
 * in the path, which title-matching would otherwise reject).
 */

const SS_HOSTS = /(^|\.)show-score\.com$/i;

/**
 * Resolve a show's Show Score page URL. Prefers the curated map
 * (data/show-score-urls.json); otherwise constructs the section + slug URL.
 */
function showScoreUrlForShow(show, urlMap) {
  if (!show) return null;
  if (urlMap && typeof urlMap[show.id] === 'string' && urlMap[show.id]) {
    return urlMap[show.id];
  }
  if (!show.title) return null;
  const slug = String(show.title)
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const cat = String(show.category || '').toLowerCase();
  const section = cat === 'off-broadway' ? 'off-broadway-shows' : 'broadway-shows';
  return `https://www.show-score.com/${section}/${slug}`;
}

/** Pull the "Read more" outlet review links from Show Score tile HTML. These are
 *  the canonical, show-specific critic review URLs. */
function extractReadMoreUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const out = new Set();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["'][^>]*>\s*Read more/gi)) {
    const u = m[1];
    try { if (!SS_HOSTS.test(new URL(u).hostname)) out.add(u.split('#')[0]); } catch { /* skip */ }
  }
  return [...out];
}

/**
 * Permissive fallback extractor (JSON-LD `url` + anchors). Kept for the initial
 * page when no "Read more" tiles are present; the caller still filters non-review
 * links. Prefer the paginated extractReadMoreUrls path.
 */
function extractShowScoreReviewUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const urls = new Set();
  const add = (u) => {
    if (!u || !/^https?:\/\//i.test(u)) return;
    let host; try { host = new URL(u).hostname; } catch { return; }
    if (SS_HOSTS.test(host)) return;
    urls.add(u.split('#')[0]);
  };
  for (const m of html.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/gi)) add(m[1]);
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) add(m[1]);
  return [...urls];
}

/** Parse pagination attributes from the critic-reviews block. */
function parseShowScorePagination(html) {
  const np = (html || '').match(/data-next-page-path=(["'])([^"']+)\1/);
  const tc = (html || '').match(/data-total-count=(["'])(\d+)\1/);
  return { nextPagePath: np ? np[2] : null, totalCount: tc ? parseInt(tc[2], 10) : 0 };
}

/**
 * Fetch ALL Show Score critic review URLs for a show, following pagination.
 *
 * @param {string} pageUrl - the show's Show Score page URL
 * @param {(url:string)=>Promise<string>} fetchHtml - returns page/JSON text for a URL
 * @returns {Promise<string[]>} de-duplicated outlet review URLs (show-page-vouched)
 */
async function fetchAllShowScoreReviewUrls(pageUrl, fetchHtml) {
  const all = new Set();
  let html = '';
  try { html = await fetchHtml(pageUrl); } catch { return []; }
  if (!html) return [];
  // Initial page: prefer "Read more" tiles; fall back to permissive extraction.
  let initial = extractReadMoreUrls(html);
  if (initial.length === 0) initial = extractShowScoreReviewUrls(html);
  initial.forEach(u => all.add(u));

  const { nextPagePath, totalCount } = parseShowScorePagination(html);
  if (nextPagePath && totalCount > 8) {
    const maxPages = Math.ceil(totalCount / 8) + 1; // safety margin
    for (let page = 2; page <= maxPages; page++) {
      let body = '';
      try { body = await fetchHtml(`https://www.show-score.com${nextPagePath}?page=${page}`); } catch { break; }
      if (!body) break;
      let tileHtml = body;
      try { tileHtml = JSON.parse(body).html || ''; } catch { /* not JSON — use as-is */ }
      if (!tileHtml || tileHtml.length < 10) break;
      const before = all.size;
      extractReadMoreUrls(tileHtml).forEach(u => all.add(u));
      if (all.size === before) break; // no new URLs → stop
    }
  }
  return [...all];
}

module.exports = {
  showScoreUrlForShow,
  extractShowScoreReviewUrls,
  extractReadMoreUrls,
  parseShowScorePagination,
  fetchAllShowScoreReviewUrls,
};
