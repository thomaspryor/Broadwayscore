/**
 * Advisory guard (BRO-5969): a deploy whose sitemap lists >3% fewer URLs than
 * the live one is probably dropping pages by accident (a noindex rule, a
 * filter bug), so it warns before the drop ships.
 */
const MAX_DROP = 0.03;

/** @returns {{ok: boolean, drop: number}} drop is the fraction lost (negative when it grew) */
function sitemapCountDelta(liveCount, localCount, maxDrop = MAX_DROP) {
  if (!liveCount || liveCount <= 0) return { ok: true, drop: 0 };
  const drop = (liveCount - localCount) / liveCount;
  return { ok: drop <= maxDrop, drop };
}

function countLocs(xml) {
  return (String(xml).match(/<loc>/g) || []).length;
}

module.exports = { sitemapCountDelta, countLocs, MAX_DROP };
