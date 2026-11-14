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
 * Policy: a failed refresh is only job-fatal when users would actually see a
 * degraded schedule: the preserved file's furthest stored week is less than
 * MIN_LOOKAHEAD_DAYS ahead of today. (Not `lastUpdated`/`currentMonday`:
 * fetch-todaytix-showtimes.js bumps both, so they cannot signal staleness.)
 * A healthy bwayrush run stores ~8 weeks ahead; cron is Mon+Thu, so ~2 weeks
 * of lookahead tolerates several missed runs before the card fires.
 */
const MIN_LOOKAHEAD_DAYS = 14;
// A week only counts when this many shows carry it (a single long-run show's
// far-future TodayTix weeks must not mask a dead bwayrush refresh).
const MIN_SHOWS_PER_WEEK = 10;

function parseWeekKey(k) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(k));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function decideScheduleFailure(existing, now = new Date(), minLookaheadDays = MIN_LOOKAHEAD_DAYS) {
  if (!existing || typeof existing !== 'object' || !existing.shows) {
    return { fatal: true, reason: 'no existing show-schedules.json to preserve' };
  }
  const counts = new Map();
  for (const s of Object.values(existing.shows)) {
    for (const w of Object.keys((s && s.weeks) || {})) {
      if (Number.isFinite(parseWeekKey(w))) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const weeks = new Set([...counts].filter(([, n]) => n >= MIN_SHOWS_PER_WEEK).map(([w]) => w));
  if (weeks.size < 2) {
    return { fatal: true, reason: `preserved schedule has only ${weeks.size} week(s)` };
  }
  const furthest = Math.max(...[...weeks].map(parseWeekKey));
  const lookahead = (furthest - now.getTime()) / 86400000;
  if (lookahead < minLookaheadDays) {
    return { fatal: true, reason: `preserved schedule only reaches ${lookahead.toFixed(1)}d ahead (< ${minLookaheadDays}d, weeks counted only if >=${MIN_SHOWS_PER_WEEK} shows carry them)` };
  }
  return { fatal: false, reason: `preserved schedule reaches ${lookahead.toFixed(1)}d ahead across ${weeks.size} weeks` };
}

module.exports = { decideScheduleFailure, MIN_LOOKAHEAD_DAYS, MIN_SHOWS_PER_WEEK };
