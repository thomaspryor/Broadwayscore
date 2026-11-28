// Pure ranking of GA4 rows with dimensions pagePath, sessionDefaultChannelGroup,
// and the implicit dateRange dimension appended by multi-range reports.
const MIN_THIS_WEEK_VIEWS = 30;
const PRIOR_FLOOR = 5;
const MIN_GROWTH = 1.5;

function rankTrendingShowPages(rows, { limit = 5, excludeDirect = true } = {}) {
  const showRe = /^\/show\/([a-z0-9-]+)\/?$/i;
  const bySlug = new Map();
  for (const row of rows) {
    const pagePath = row.dimensionValues?.[0]?.value || '';
    const channel = row.dimensionValues?.[1]?.value || '';
    const rangeName = row.dimensionValues?.[2]?.value || '';
    if (excludeDirect && channel === 'Direct') continue;
    const m = showRe.exec(pagePath);
    if (!m) continue;
    const views = parseInt(row.metricValues?.[0]?.value || '0', 10);
    if (!Number.isFinite(views) || views < 0) continue;
    const slug = m[1];
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, views: 0, prior: 0 });
    const entry = bySlug.get(slug);
    // Each channel (and trailing-slash variant) contributes to the same show.
    if (rangeName === 'thisWeek' || rangeName === 'date_range_0') entry.views += views;
    else if (rangeName === 'priorWeek' || rangeName === 'date_range_1') entry.prior += views;
  }

  const climbers = [];
  for (const entry of bySlug.values()) {
    if (entry.views < MIN_THIS_WEEK_VIEWS) continue;
    const growth = entry.views / Math.max(entry.prior, PRIOR_FLOOR);
    if (growth < MIN_GROWTH) continue;
    climbers.push({ ...entry, growth });
  }
  climbers.sort((a, b) => b.growth - a.growth);
  return climbers.slice(0, limit);
}

// BRO-2503: what share of this week's /show/ page views arrive on the Direct
// channel (the one BRO-44 found to be mostly bot traffic).
function directShareOfShowViews(rows) {
  const showRe = /^\/show\/([a-z0-9-]+)\/?$/i;
  let total = 0;
  let direct = 0;
  for (const row of rows) {
    const rangeName = row.dimensionValues?.[2]?.value || '';
    if (rangeName !== 'thisWeek' && rangeName !== 'date_range_0') continue;
    if (!showRe.test(row.dimensionValues?.[0]?.value || '')) continue;
    const views = parseInt(row.metricValues?.[0]?.value || '0', 10);
    if (!Number.isFinite(views) || views < 0) continue;
    total += views;
    if (row.dimensionValues?.[1]?.value === 'Direct') direct += views;
  }
  return { total, direct, share: total ? direct / total : null };
}

module.exports = { rankTrendingShowPages, directShareOfShowViews };
