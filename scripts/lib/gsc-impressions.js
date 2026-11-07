/**
 * Pure helpers for the 90-day Search Console impressions snapshot (BRO-5992).
 * data/seo-gsc-impressions.json is read by scripts/lib/seo-indexability.js.
 */
const PAGE_PREFIX = /^\/(show|cast|critics|opera)\//;

/** GSC page URL -> site path without host, query or trailing slash; null if not a tracked page. */
function normalizePagePath(pageUrl) {
  let p;
  try { p = new URL(pageUrl).pathname; } catch { return null; }
  p = p.replace(/\/+$/, '');
  return PAGE_PREFIX.test(p) ? p : null;
}

/** Sum impressions per tracked path (www and apex hosts, with and without slash, collapse). */
function aggregateRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const p = normalizePagePath(r && r.keys && r.keys[0]);
    if (!p) continue;
    out[p] = (out[p] || 0) + (Number(r.impressions) || 0);
  }
  return out;
}

/**
 * Top search queries landing on /opera pages (BRO-6769). Rows come from a
 * dimensions ["query","page"] pull; sums clicks and impressions per query across
 * the www/apex and slash variants of each page and keeps the top `limit`.
 */
function aggregateOperaQueries(rows, limit = 50) {
  const byQuery = {};
  for (const r of rows || []) {
    const [query, page] = (r && r.keys) || [];
    const p = normalizePagePath(page);
    if (!query || !p || !p.startsWith('/opera/')) continue;
    const q = byQuery[query] || (byQuery[query] = { query, impressions: 0, clicks: 0, pages: {} });
    q.impressions += Number(r.impressions) || 0;
    q.clicks += Number(r.clicks) || 0;
    q.pages[p] = (q.pages[p] || 0) + (Number(r.impressions) || 0);
  }
  return Object.values(byQuery)
    .map(q => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, topPage: Object.entries(q.pages).sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
    .slice(0, limit);
}

module.exports = { normalizePagePath, aggregateRows, aggregateOperaQueries };
