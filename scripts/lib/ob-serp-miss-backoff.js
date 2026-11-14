/**
 * ob-serp-miss-backoff.js — stop paying for a Playbill SERP lookup that keeps
 * finding nothing (BRO-3528).
 *
 * enrich-off-broadway-dates.js Phase 3 runs discoverOBPlaybillUrl (one SERP
 * credit) for every same-date candidate on every run. Playbill does not index
 * some productions at all (Repertorio Español's rotating rep, Met Opera
 * titles, Magic Mike Live...), so ~23 shows logged `no-playbill-production-url`
 * on every run in Oct 2026, forever.
 *
 * Decision, from the run log the workflow already commits
 * (data/audit/date-enrichment-corrections.json `runs`, newest last): walk this
 * show's appearances newest→oldest; count runs whose outcome was a SERP miss,
 * skip over transient `serp-error*` outcomes (a quota blip must not reset the
 * streak), and stop at any other outcome. With >= minMisses consecutive misses
 * and the newest one < cooldownDays old, skip the SERP. Once the cooldown
 * passes, one probe runs again (and logs a miss, restarting the cooldown), so
 * a show Playbill later indexes is picked up within a month.
 */

const MISS_REASON = 'no-playbill-production-url';
const NEUTRAL_REASON_RE = /^serp-error/;
const DEFAULTS = { minMisses: 3, cooldownDays: 30 };

/**
 * @param {string} showId
 * @param {Array<{runAt:string, entries:Array<{showId:string, reason?:string}>}>} runs  oldest first
 * @param {Date} now
 * @param {{minMisses?:number, cooldownDays?:number}} [opts]
 * @returns {{skip:boolean, misses:number, lastMissAt:string|null}}
 */
function serpBackoffDecision(showId, runs, now = new Date(), opts = {}) {
  const { minMisses, cooldownDays } = { ...DEFAULTS, ...opts };
  let misses = 0;
  let lastMissAt = null;
  const list = Array.isArray(runs) ? runs : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const run = list[i];
    const mine = (run && Array.isArray(run.entries) ? run.entries : []).filter((e) => e && (e.showId || e.id) === showId);
    // 'applied' entries carry the show as `id`, audit-only ones as `showId`.
    if (mine.length === 0) continue;
    const reasons = mine.map((e) => e.reason || '');
    if (reasons.every((r) => NEUTRAL_REASON_RE.test(r))) continue;
    if (reasons.every((r) => r === MISS_REASON || NEUTRAL_REASON_RE.test(r))) {
      misses++;
      if (!lastMissAt) lastMissAt = run.runAt || null;
      continue;
    }
    break; // any other outcome (applied, page found but rejected, ...) ends the streak
  }
  const ageDays = lastMissAt ? (now.getTime() - Date.parse(lastMissAt)) / 86400000 : Infinity;
  return { skip: misses >= minMisses && ageDays < cooldownDays, misses, lastMissAt };
}

/**
 * Only the same-date class (IBDB-conflated openingDate == previewsStartDate)
 * backs off. A show in previews with no openingDate has Phase 3 as its only
 * date source and stays probed every run.
 */
function isBackoffEligible(show) {
  return !!(show && show.openingDate && show.previewsStartDate && show.openingDate === show.previewsStartDate);
}

module.exports = { serpBackoffDecision, isBackoffEligible, MISS_REASON };
