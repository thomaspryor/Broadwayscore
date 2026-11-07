'use strict';

/**
 * cost-anchor-checks.js — BRO-4989 step 10, the weekly cost-data checks:
 *   stale   open show whose newest REPORTED cost figure (not our estimate,
 *           with a real date) is over 3 years old, or that has none: queue a
 *           refresh
 *   floor   current cost below the category floor (union musical < $350K/wk)
 *   tier    an anchor or legacy figure without a valid source tier
 * Pure: callers pass records, shows and the cost history to check.
 */

const { anchorErrors } = require('./cost-history');

const STALE_YEARS = 3;
const FLOORS = { musical: 350_000, musicalSpectacle: 350_000 };
const YEAR_MS = 365.25 * 86400000;
const KNOWN_DATE_SOURCES = /^(source-text|sources)/;

/** A figure someone reported, with a date we read rather than assumed. */
function isDatedReport(a) {
  if (a.sourceType === 'industry-estimate') return false;
  return a.dateBasis !== 'migrated' || KNOWN_DATE_SOURCES.test(String(a.dateFrom || ''));
}

/**
 * @param {{ slug, record, show, history, currentCost, category, now }} p
 * @returns {{ slug, stale: object|null, floor: object|null, tier: string[] }}
 */
function checkCostAnchors({ slug, record, show, history, currentCost, category, now = Date.now() }) {
  const out = { slug, stale: null, floor: null, tier: [] };
  const open = show?.openingDate && Date.parse(show.openingDate) <= now && (!show.closingDate || Date.parse(show.closingDate) > now);

  if (open) {
    const reports = (history || []).filter(isDatedReport).sort((a, b) => a.asOf.localeCompare(b.asOf));
    const newest = reports[reports.length - 1] || null;
    const ageYears = newest ? (now - Date.parse(newest.asOf)) / YEAR_MS : null;
    if (!newest || ageYears > STALE_YEARS) {
      out.stale = { newest: newest ? `${newest.asOf} $${newest.amount} (${newest.sourceType})` : null, ageYears: ageYears === null ? null : Math.round(ageYears * 10) / 10 };
    }
    const floor = FLOORS[category];
    if (floor && Number.isFinite(currentCost) && currentCost < floor) out.floor = { currentCost, floor, category };
  }

  for (const a of history || []) {
    const errs = anchorErrors(a);
    if (errs.length) out.tier.push(`${a.asOf}: ${errs.join('; ')}`);
  }
  if (Number.isFinite(record?.weeklyRunningCost) && !record.costMethodology) out.tier.push('weeklyRunningCost has no costMethodology (source tier)');
  return out;
}

/**
 * Research already ran recently: a refresh can come back with only an
 * estimate (deep research maps to industry-estimate), which never clears
 * "stale", so without a cooldown the same show is re-queued every week.
 */
const RESEARCH_COOLDOWN_DAYS = 180;
function recentlyResearched(record, now = Date.now(), days = RESEARCH_COOLDOWN_DAYS) {
  // lastResearchedAt: written by the queue worker (deep-research-commercial.js);
  // deepResearch.verifiedDate: curated research blocks. The later one counts.
  const d = Math.max(...[record?.lastResearchedAt, record?.deepResearch?.verifiedDate]
    .map((v) => Date.parse(v || '')).filter(Number.isFinite), -Infinity);
  return Number.isFinite(d) && now - d < days * 86400000;
}

/** Refresh order: no reported figure first, then oldest. */
function refreshOrder(results) {
  return results.filter((r) => r.stale)
    .sort((a, b) => (b.stale.ageYears ?? Infinity) - (a.stale.ageYears ?? Infinity) || a.slug.localeCompare(b.slug));
}

module.exports = { checkCostAnchors, refreshOrder, isDatedReport, recentlyResearched, RESEARCH_COOLDOWN_DAYS, STALE_YEARS, FLOORS };
