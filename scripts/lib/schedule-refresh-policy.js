'use strict';
/**
 * BRO-7332: when the bwayrush /api/calendar fetch returns nothing, should the
 * whole Update Lottery/Rush job go red?
 *
 * Root cause of the recurring "Cron's latest run failed: Update Lottery/Rush"
 * cards (BRO-6364/6431/7287): the multi-week schedule refresh is a secondary,
 * flaky (Cloudflare) source, yet any failure set process.exitCode=1 and failed
 * the job even though the lottery/rush data had been scraped fine and the
 * existing show-schedules.json was kept. Every proxy blip => alert card.
 *
 * Policy: a failed refresh is only job-fatal when the preserved file is too old
 * (or single-week), i.e. users would actually see stale/degraded schedules.
 * Cron is Mon+Thu (max gap ~4 days), so >6 days old means >=1 run was missed.
 */
const MAX_STALE_DAYS = 6;

function decideScheduleFailure(existing, now = new Date(), maxStaleDays = MAX_STALE_DAYS) {
  if (!existing || typeof existing !== 'object' || !existing.lastUpdated) {
    return { fatal: true, reason: 'no existing show-schedules.json to preserve' };
  }
  const ts = Date.parse(existing.lastUpdated);
  if (!Number.isFinite(ts)) return { fatal: true, reason: 'existing lastUpdated is unparseable' };
  const ageDays = (now.getTime() - ts) / 86400000;
  if (ageDays > maxStaleDays) {
    return { fatal: true, reason: `preserved schedule is ${ageDays.toFixed(1)}d old (> ${maxStaleDays}d)` };
  }
  const weeks = new Set();
  for (const s of Object.values(existing.shows || {})) {
    for (const w of Object.keys((s && s.weeks) || {})) weeks.add(w);
  }
  if (weeks.size < 2) {
    return { fatal: true, reason: `preserved schedule has only ${weeks.size} week(s)` };
  }
  return { fatal: false, reason: `preserved schedule is ${ageDays.toFixed(1)}d old with ${weeks.size} weeks` };
}

module.exports = { decideScheduleFailure, MAX_STALE_DAYS };
