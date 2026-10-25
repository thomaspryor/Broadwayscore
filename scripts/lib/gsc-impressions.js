/**
 * Pure helpers for the 90-day Search Console impressions snapshot (BRO-5992).
 * data/seo-gsc-impressions.json is read by scripts/lib/seo-indexability.js.
 */
const PAGE_PREFIX = /^\/(show|cast|critics)\//;

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

module.exports = { normalizePagePath, aggregateRows };
