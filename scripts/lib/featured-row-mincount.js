// BRO-4284: homepage FeaturedRow hides itself when shows.length < minCount
// (default 4, src/components/HomePageClient.tsx). Rows that omit minCount
// vanish silently when their list shrinks. Pure classifier; the script
// scripts/audit-featured-row-mincount.js supplies live row sizes.

const DEFAULT_MIN_COUNT = 4;
const AT_RISK_MARGIN = 2; // within this many shows of the floor

/** rows: [{ title, count, minCount|null }] -> advisory findings for rows with no explicit minCount. */
function classifyFeaturedRows(rows, defaultMin = DEFAULT_MIN_COUNT) {
  return rows
    .filter((r) => r && (r.minCount === null || r.minCount === undefined))
    .map((r) => {
      let status = 'ok';
      if (r.count < defaultMin) status = 'hidden';
      else if (r.count < defaultMin + AT_RISK_MARGIN) status = 'at-risk';
      return { title: r.title, count: r.count, effectiveMin: defaultMin, status };
    });
}

module.exports = { DEFAULT_MIN_COUNT, AT_RISK_MARGIN, classifyFeaturedRows };
