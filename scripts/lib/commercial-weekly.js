'use strict';

/**
 * BRO-825: one weekly commercial snapshot, with no composite score.
 * Health = four full weeks' average gross / the existing break-even estimate.
 * Market health = the percentage of rated shows that are Healthy or Blockbuster.
 */

/** @typedef {'Blockbuster' | 'Healthy' | 'Holding' | 'Struggling' | 'Critical'} HealthTier */
/** @typedef {{ gross?: number | null, performances?: number | null }} Week */
/** @typedef {{ label: string, description: string, textClass: string }} Outcome */
/** @typedef {{ slug: string, title: string, category: string, status: string, startDate?: string | null, closingDate?: string | null, breakEven: number | null, outcome: Outcome }} Show */
/** @typedef {{ slug: string, title: string, gross: number, change: number | null, changePct: number | null, health: HealthTier | null, healthReason: string | null, outcome: Outcome }} WeeklyShow */

const DAY = 86_400_000;
const offsetWeek = (week, offset) => new Date(Date.parse(week) + offset * 7 * DAY).toISOString().slice(0, 10);
const positive = (value) => Number.isFinite(value) && value > 0;
const reported = (row) => row && positive(row.gross) && positive(row.performances);

/** @returns {HealthTier | null} */
function commercialHealth(averageGross, breakEven) {
  if (!positive(averageGross) || !positive(breakEven)) return null;
  const ratio = averageGross / breakEven;
  if (ratio >= 1.5) return 'Blockbuster';
  if (ratio >= 1.1) return 'Healthy';
  if (ratio >= 0.9) return 'Holding';
  if (ratio >= 0.7) return 'Struggling';
  return 'Critical';
}

/**
 * Exact calendar weeks only: a gap must never become a week-over-week change.
 * New productions cannot inherit another run's history under the same slug.
 * @param {{ shows: Show[], weeks: Record<string, Record<string, Week>>, weekEnding: string | null, today: string, maxAgeDays: number }} input
 */
function buildCommercialWeekly({ shows, weeks, weekEnding, today, maxAgeDays }) {
  const latest = Object.keys(weeks).sort().at(-1) ?? null;
  const age = weekEnding ? (Date.parse(today) - Date.parse(weekEnding)) / DAY : NaN;
  const unavailableReason = !weekEnding || !latest
    ? 'Weekly grosses are not available yet.'
    : latest !== weekEnding
      ? 'Weekly grosses are updating. Check back for a complete snapshot.'
      : !Number.isFinite(age) || age < 0 || age > maxAgeDays
        ? 'Weekly grosses are out of date. The snapshot will return after the next update.'
        : null;
  /** @type {WeeklyShow[]} */
  const rows = [];
  const priorWeek = weekEnding && !unavailableReason ? offsetWeek(weekEnding, -1) : null;
  if (!unavailableReason) {
    const seen = new Set();
    for (const show of shows) {
      if (show.category !== 'broadway' || !['open', 'previews'].includes(show.status) || seen.has(show.slug)) continue;
      seen.add(show.slug);
      const inRun = (week) => (!show.startDate || week >= show.startDate)
        && (!show.closingDate || week <= offsetWeek(show.closingDate, 1));
      const current = weeks[weekEnding]?.[show.slug];
      if (!inRun(weekEnding) || !reported(current)) continue;
      const previous = inRun(priorWeek) ? weeks[priorWeek]?.[show.slug] : null;
      const change = reported(previous) ? current.gross - previous.gross : null;
      const recent = Array.from({ length: 4 }, (_, i) => {
        const week = offsetWeek(weekEnding, -i);
        return inRun(week) ? weeks[week]?.[show.slug] : null;
      });
      // Partial performance weeks can exaggerate a cost shortfall. Keep their
      // actual gross change in movers, but do not assign a current health tier.
      const fullWeeks = recent.every((row) => reported(row) && row.performances >= 7);
      const health = fullWeeks ? commercialHealth(recent.reduce((sum, row) => sum + row.gross, 0) / 4, show.breakEven) : null;
      rows.push({
        slug: show.slug, title: show.title, gross: current.gross,
        change, changePct: change == null ? null : change / previous.gross * 100,
        health,
        healthReason: health ? null : !positive(show.breakEven) ? 'Cost unavailable' : 'Needs four full weeks',
        outcome: show.outcome,
      });
    }
  }
  const rated = rows.filter((row) => row.health !== null);
  const healthyCount = rated.filter((row) => row.health === 'Blockbuster' || row.health === 'Healthy').length;
  const tieBreak = (a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);
  return {
    weekEnding, previousWeekEnding: priorWeek,
    unavailableReason,
    reportingCount: rows.length, ratedCount: rated.length, healthyCount,
    index: rated.length ? Math.round(healthyCount / rated.length * 100) : null,
    shows: rows,
    movers: rows.filter((row) => row.change > 0).sort((a, b) => b.change - a.change || tieBreak(a, b)).slice(0, 3),
    fallers: rows.filter((row) => row.change < 0).sort((a, b) => a.change - b.change || tieBreak(a, b)).slice(0, 3),
  };
}

module.exports = { commercialHealth, buildCommercialWeekly };
