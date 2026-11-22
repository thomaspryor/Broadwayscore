'use strict';
const { slowMarketListedGap, inSlowMarketWindow } = require('./slow-market-gap');
const { currentRunOnly, currentRunCount } = require('./prior-production-citations');

const ROUNDUP_GAP_ALERT_DAYS = 3;
function planRoundupGapAlerts(results, ingestMissing, now = Date.now(), { showById } = {}) {
  const alert = [];
  const resolve = [];
  for (const row of results || []) {
    // BRO-6687 (the BRO-5489 rule): judge the window from today's shows.json
    // entry, not the row. A carried row keeps the openingDate of its last audit
    // (dogstar-off-west-end-2026: row openingDate null, show opened 2026-10-31),
    // so the slow-market alert silently skipped an in-window opening.
    const s = showById && row ? showById.get(row.showId) : null;
    const r = s ? { ...row, category: s.category || row.category, openingDate: s.openingDate || row.openingDate } : row;
    const opened = r.openingDate ? Date.parse(r.openingDate) : NaN;
    const inRoundupWindow = ['broadway', 'off-broadway'].includes(r.category)
      && Number.isFinite(opened) && opened <= now && now - opened <= ROUNDUP_GAP_ALERT_DAYS * 86400000;
    // BRO-6687: off-Broadway past day 3, West End and off-West End stay in for the
    // audit's 21-day window, counting only cited rows and reverify exclusions.
    if (!inRoundupWindow && inSlowMarketWindow(r, now)) {
      const { rows, ...counts } = slowMarketListedGap(r);
      if (counts.residual > 0) alert.push({ showId: r.showId, title: r.title, counts, missing: rows });
      else resolve.push(r.showId);
      continue;
    }
    if (!inRoundupWindow) continue;
    const { rows, ...counts } = slowMarketListedGap(r);
    if (counts.residual > 0) alert.push({ showId: r.showId, title: r.title, counts, missing: rows });
    // Resolve only on a run that actually found the roundups: a discovery miss (SERP
    // outage, Verdict fetch failure) also shows residual 0 and would close the incident,
    // so the next run's gap would file a fresh duplicate card.
    else if ((r.aggregatorArticles || []).length > 0) resolve.push(r.showId);
  }
  return { alert, resolve };
}

function computeResidualCounts(r, ingestMissing) {
  const failedIngest = (r.ingestResults || []).filter(x => !x.ok && !x.noop).length;
  const noopIngest = (r.ingestResults || []).filter(x => x.noop).length;
  const conflictIngest = (r.ingestResults || []).filter(x => x.conflict).length;
  const expectedIngest = (r.ingestResults || []).filter(x => x.expected).length;
  const unclassifiedIngest = (r.ingestResults || []).filter(x => x.unclassified).length;
  const capped = (r.ingestSkippedByCap || []).length;
  const uningested = ingestMissing ? 0 : currentRunCount(r.missing);
  const recovered = (r.recoveryResults || []).filter(x => x.recovered && !x.uncited).length;
  // confirmedNonReview rows (BRO-5500): the exclusion is the correct outcome, not a gap.
  const flaggedOut = Math.max(0, currentRunCount((r.flaggedMisses || []).filter(m => !(m && (m.confirmedNonReview || m.liveInReviews)))) - recovered);
  const residual = failedIngest + capped + uningested + flaggedOut + conflictIngest + unclassifiedIngest;
  return { residual, failedIngest, noopIngest, conflictIngest, expectedIngest, unclassifiedIngest, capped, uningested, flaggedOut, recovered };
}

module.exports = { planRoundupGapAlerts, computeResidualCounts };
