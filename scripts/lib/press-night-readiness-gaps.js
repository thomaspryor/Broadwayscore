'use strict';
/**
 * BRO-7779 items 4 and 8: two press-night gaps that used to be silent, as daily health rows.
 *
 * Item 4, "Press night: openings not watched". The opening-night lane times every night off an embargo hour, and
 * press-night-record.js EMBARGO_HOUR_LOCAL only has one for Broadway, Off-Broadway, the West End and Off-West End.
 * A regional or touring opening has no hour (and no reviewEmbargoAt override), so no lane, probe or record ever
 * starts for it and nothing said so. Each such opening in the next UNWATCHED_LOOKAHEAD_DAYS was named (BRO-8146: regional and touring are now sweep-only and not listed; the row names only an unknown or missing category).
 *
 * Item 8 (retired 2026-11-23, BRO-8163): "Press night: score gate undecided" asked the owner, show by show, whether a special
 * or short run should show its Critic Score on few reviews. The owner answered once for all of them (3 reviews), so the
 * rule now lives in scripts/lib/score-gate-rule.js and both score readers apply it automatically; no show is left
 * undecided and the row is gone.
 *
 * Pure functions over plain data (CLAUDE.md rule 15); health-check.js reads the files and the clock.
 */

const UNWATCHED_LOOKAHEAD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`));
// Today in New York: the check runs at 02:15Z, still the previous evening there, and a UTC date would call tomorrow tonight.
const dayOf = (ms, timeZone = 'America/New_York') => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
// BRO-8146: regional and touring openings are sweep-only by design (no lane market, no embargo hour; 1,300+ regional
// shows, mostly community theatre). Naming each one daily made the row permanent noise. press-night-record ignores a
// reviewEmbargoAt on a category with no market, so an override would not change that. The row now only names a show
// whose category the lane does not know (missing or new market): fix the category or add the market.
const SWEEP_ONLY_CATEGORIES = new Set(['regional', 'tour']);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** Shows opening in [today, today + days]. A show with no real opening date cannot be planned for and is skipped. */
function upcoming(shows, nowMs, days) {
  const today = dayOf(nowMs);
  return (shows || []).filter((s) => s && s.id && isDay(s.openingDate)
    && s.status !== 'closed' && daysBetween(today, s.openingDate) >= 0 && daysBetween(today, s.openingDate) <= days);
}

/**
 * Item 4. `embargoAt(show)` returns the embargo the lane would use (press-night-record embargoInfo().at), or null when
 * the show's market has no hour. Returns [{id, title, category, openingDate, inDays}] sorted by opening date.
 */
function unwatchedOpenings(shows, { nowMs, embargoAt, days = UNWATCHED_LOOKAHEAD_DAYS }) {
  const today = dayOf(nowMs);
  return upcoming(shows, nowMs, days)
    .filter((s) => !SWEEP_ONLY_CATEGORIES.has(s.category))
    .filter((s) => { try { return !embargoAt(s); } catch { return true; } })
    .map((s) => ({ id: s.id, title: s.title || s.id, category: s.category || null, openingDate: s.openingDate, inDays: daysBetween(today, s.openingDate) }))
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate) || a.id.localeCompare(b.id));
}

const when = (n) => (n === 0 ? 'tonight' : n === 1 ? 'tomorrow' : `in ${n} days`);
const list = (items, fmt, max = 8) => items.slice(0, max).map(fmt).join('; ') + (items.length > max ? `; and ${items.length - max} more` : '');

/** The health row. Always one row (a pass row when clear), so a fixed card can verify against it. */
function pressNightReadinessResults({ shows, nowMs, embargoAt }) {
  const unwatched = unwatchedOpenings(shows, { nowMs, embargoAt });
  return [
    unwatched.length
      ? { name: 'Press night: openings not watched', status: 'warn', items: unwatched,
        message: `${unwatched.length} opening(s) in the next ${UNWATCHED_LOOKAHEAD_DAYS} days have no press-night watch (their category has no press-night market, so no lane or probe runs; reviews arrive only through the daily sweeps): ${list(unwatched, (u) => `${u.title} (${u.category || 'no category'}, ${when(u.inDays)})`)}`,
        hint: 'The show category is missing or not a lane market. Fix the category, or add the new market to EMBARGO_HOUR_LOCAL and MARKET_TZ. Regional and touring openings are sweep-only by design and are not listed.' }
      : { name: 'Press night: openings not watched', status: 'pass', message: `Every opening in the next ${UNWATCHED_LOOKAHEAD_DAYS} days has a press-night watch` },
  ];
}

module.exports = {
  unwatchedOpenings, pressNightReadinessResults,
  SWEEP_ONLY_CATEGORIES, UNWATCHED_LOOKAHEAD_DAYS,
};
