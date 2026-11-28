/**
 * shared-url-quote-detector (BRO-4594): finds one article URL filed under 2+
 * shows whose records carry the SAME pull quote and no per-show score override.
 * A critic who reviews two shows in one column rarely means the same line for
 * both, so a shared quote is the tell that the whole column was copied and
 * scored once. Pure: takes records, returns groups; no I/O.
 */

const normQuote = (q) => String(q || '').replace(/[‘’“”'"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// A URL with no path beyond the host (a homepage placeholder) says nothing
// about the article, so it is never a shared-article signal.
function articleKey(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, '');
  if (p.split('/').filter(Boolean).length < 1 || p.length < 8) return null;
  return `${u.hostname.replace(/^www\./, '')}${p}${u.search}`.toLowerCase();
}

/**
 * @param {Array<{showId:string,file:string,url:string,llmPullQuote?:string,humanReviewScore?:number}>} records
 * @returns {Array<{key:string, quote:string, records:Array}>}
 */
function findSharedQuoteGroups(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = articleKey(r.url);
    if (!key || !r.llmPullQuote || r.humanReviewScore != null) continue;
    const id = `${key}\n${normQuote(r.llmPullQuote)}`;
    if (!byKey.has(id)) byKey.set(id, { key, quote: r.llmPullQuote, records: [] });
    byKey.get(id).records.push(r);
  }
  // Different runs of one title (a-christmas-carol-1991 / -2019) are other
  // audits' business (wrong-production guards); a split needs different titles.
  return [...byKey.values()].filter((g) => new Set(g.records.map((r) => baseSlug(r.showId))).size > 1);
}

function baseSlug(showId) {
  return String(showId).replace(/(?:-(?:off-west-end|west-end|off-off-broadway|off-broadway|bway|broadway|regional|tour|london))*(?:-\d{4}(?:-\d+|-revival)?)?$/, '');
}

module.exports = { findSharedQuoteGroups, articleKey, normQuote, baseSlug };
