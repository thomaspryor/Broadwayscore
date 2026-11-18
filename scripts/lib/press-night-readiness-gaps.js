'use strict';
/**
 * BRO-7779 items 4 and 8: two press-night gaps that used to be silent, as daily health rows.
 *
 * Item 4, "Press night: openings not watched". The opening-night lane times every night off an embargo hour, and
 * press-night-record.js EMBARGO_HOUR_LOCAL only has one for Broadway, Off-Broadway, the West End and Off-West End.
 * A regional or touring opening has no hour (and no reviewEmbargoAt override), so no lane, probe or record ever
 * starts for it and nothing said so. Each such opening in the next UNWATCHED_LOOKAHEAD_DAYS is now named.
 *
 * Item 8, "Press night: score gate undecided". A special, or a short engagement (UNDER SHORT_RUN_DAYS between
 * opening and closing), draws few critics, so the market minimum can keep its Critic Score hidden all run
 * (Blue Man Group, 2026-11-17: the gate decision came after the night, BRO-7750). Within SCORE_GATE_LOOKAHEAD_DAYS
 * of opening, such a show with no entry in data/score-gate-overrides.json is named so the call is made before
 * the night. A decision to keep the market minimum goes under keptMarketMinimum (outside `shows`, which the site reads,
 * so it changes nothing there) and also silences the row. Only Broadway and the West End, plus any special, are asked:
 * a short run is the norm Off-Broadway, Off-West End and regionally, and asking about every one would flood the owner.
 *
 * Pure functions over plain data (CLAUDE.md rule 15); health-check.js reads the files and the clock.
 */

const UNWATCHED_LOOKAHEAD_DAYS = 14;
const SCORE_GATE_LOOKAHEAD_DAYS = 7;
const SHORT_RUN_DAYS = 56; // 8 weeks
const DAY_MS = 24 * 60 * 60 * 1000;

const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`));
// Today in New York: the check runs at 02:15Z, still the previous evening there, and a UTC date would call tomorrow tonight.
const dayOf = (ms, timeZone = 'America/New_York') => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const GATED_SHORT_RUN_CATEGORIES = new Set(['broadway', 'west-end']);
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
    .filter((s) => { try { return !embargoAt(s); } catch { return true; } })
    .map((s) => ({ id: s.id, title: s.title || s.id, category: s.category || null, openingDate: s.openingDate, inDays: daysBetween(today, s.openingDate) }))
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate) || a.id.localeCompare(b.id));
}

/** Why a show needs a score-gate decision before its night ('special' / 'short run (N days)'), or null. */
function scoreGateReason(show) {
  if (!show) return null;
  if (String(show.type || '').toLowerCase() === 'special') return 'special';
  if (GATED_SHORT_RUN_CATEGORIES.has(show.category) && isDay(show.openingDate) && isDay(show.closingDate)) {
    const run = daysBetween(show.openingDate, show.closingDate);
    if (run >= 0 && run <= SHORT_RUN_DAYS) return `short run (${run} days)`;
  }
  return null;
}

/**
 * Item 8. `overrides` is the parsed data/score-gate-overrides.json. Any entry for the show is a decision (a number
 * lowers the gate, null keeps the market minimum). Returns [{id, title, openingDate, inDays, reason}].
 */
function scoreGateUndecided(shows, overrides, { nowMs, days = SCORE_GATE_LOOKAHEAD_DAYS }) {
  const lowered = (overrides && overrides.shows) || {};
  const kept = (overrides && overrides.keptMarketMinimum) || {};
  // A decision is a lowered minimum the site reads (a whole number >= 1, as scoreGateArg does) or a recorded "keep"
  // with who approved it. A malformed entry ({} or "3") changes nothing on the site, so it does not silence the row.
  const has = (o, id) => Object.prototype.hasOwnProperty.call(o, id) && o[id] && typeof o[id] === 'object';
  const isDecision = (id) => (has(lowered, id) && Number.isInteger(lowered[id].minReviews) && lowered[id].minReviews >= 1) || (has(kept, id) && !!kept[id].approvedBy);
  const today = dayOf(nowMs);
  return upcoming(shows, nowMs, days)
    .filter((s) => !isDecision(s.id))
    .map((s) => ({ s, reason: scoreGateReason(s) }))
    .filter((x) => x.reason)
    .map(({ s, reason }) => ({ id: s.id, title: s.title || s.id, openingDate: s.openingDate, inDays: daysBetween(today, s.openingDate), reason }))
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate) || a.id.localeCompare(b.id));
}

const when = (n) => (n === 0 ? 'tonight' : n === 1 ? 'tomorrow' : `in ${n} days`);
const list = (items, fmt, max = 8) => items.slice(0, max).map(fmt).join('; ') + (items.length > max ? `; and ${items.length - max} more` : '');

/** The two health rows. Always one row per check (a pass row when clear), so a fixed card can verify against it. */
function pressNightReadinessResults({ shows, overrides, nowMs, embargoAt }) {
  const unwatched = unwatchedOpenings(shows, { nowMs, embargoAt });
  const undecided = scoreGateUndecided(shows, overrides, { nowMs });
  return [
    unwatched.length
      ? { name: 'Press night: openings not watched', status: 'warn', items: unwatched,
        message: `${unwatched.length} opening(s) in the next ${UNWATCHED_LOOKAHEAD_DAYS} days have no press-night watch (no embargo hour for their market, so no lane or probe runs; reviews arrive only through the daily sweeps): ${list(unwatched, (u) => `${u.title} (${u.category}, ${when(u.inDays)})`)}`,
        hint: 'Not watched on purpose unless someone adds a market hour (EMBARGO_HOUR_LOCAL) or a reviewEmbargoAt for the show.' }
      : { name: 'Press night: openings not watched', status: 'pass', message: `Every opening in the next ${UNWATCHED_LOOKAHEAD_DAYS} days has a press-night watch` },
    undecided.length
      ? { name: 'Press night: score gate undecided', status: 'warn', items: undecided,
        message: `${undecided.length} special or short-run show(s) open within ${SCORE_GATE_LOOKAHEAD_DAYS} days with no score-gate decision, so few reviews may keep the Critic Score hidden: ${list(undecided, (u) => `${u.title} (${u.reason}, opens ${when(u.inDays)})`)}`,
        hint: 'Record the decision in data/score-gate-overrides.json: shows.<id> {minReviews N, approvedBy, reason} to lower the gate, or keptMarketMinimum.<id> {approvedBy, reason} to keep the market minimum.' }
      : { name: 'Press night: score gate undecided', status: 'pass', message: `No special or short-run show opens within ${SCORE_GATE_LOOKAHEAD_DAYS} days without a score-gate decision` },
  ];
}

module.exports = {
  unwatchedOpenings, scoreGateUndecided, scoreGateReason, pressNightReadinessResults,
  UNWATCHED_LOOKAHEAD_DAYS, SCORE_GATE_LOOKAHEAD_DAYS, SHORT_RUN_DAYS,
};
