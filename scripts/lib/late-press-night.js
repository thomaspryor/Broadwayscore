'use strict';
/**
 * BRO-7808: the decision for a show nobody is watching that suddenly shows a press-night signal.
 *
 * Now You See Me Live had openingDate 2026-11-11 (first performance) but its critics were embargoed to 2026-11-18. Every
 * press-night path keys off openingDate, so no lane lease, night run or watchdog existed on the real night, and the
 * reviews arrived only by the regular sweep. This is the pure decision; scripts/late-press-night-watch.js is the part that
 * reads the lease store and the BWW homepage and tells the coordinator. Stored reviews lag the night (nothing ingests when
 * no lane runs), so the first signal is the live BWW "Review Roundup ... Opens" link, the second a burst of tier 1/2
 * reviews (readiness-lane.lateEmbargoVerdict, the one detector the readiness check uses too).
 *
 * Routing only: the coordinator (BRO-5955) owns press night, so this never starts a lane itself.
 */
const RL = require('./readiness-lane');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PRESS_NIGHT_AGE_DAYS = 2;
const RECENT_DAYS = 2;

/** The YYYYMMDD a BWW article URL ends with, as YYYY-MM-DD; null when it has none. */
function roundupDayFromUrl(url) {
  const m = /-(\d{4})(\d{2})(\d{2})(?:[/?#]|$)/.exec(String(url || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Stable marker for dedupe: one alert per show and signal day, whichever sweep raises it. */
function alertMarker(showId, day) {
  return `late-press-night:${showId}:${day}`;
}

/**
 * @param {{show: object, reviews?: object[], roundupUrl?: string|null, lease?: object|null, nowMs: number,
 *          tierOf?: (review: object) => number}} input
 *   lease: the show's active lane lease, null when none, {unknown:true} when the lease store could not be read.
 *   roundupUrl: the BWW Review Roundup link found for this show on the live BWW homepage, if any.
 * @returns {{action: 'none'|'route-coordinator', signal: 'bww-roundup'|'tier12-burst'|null, day: string|null, reason: string, marker: string|null}}
 */
function decideLatePressNight({ show, reviews = [], roundupUrl = null, lease = null, nowMs, tierOf } = {}) {
  const none = (reason) => ({ action: 'none', signal: null, day: null, reason, marker: null });
  if (!show || !show.openingDate) return none('no opening date');
  if ((show.category || 'broadway') !== 'broadway' || (show.status && !['open', 'previews'].includes(show.status))) return none('not an open Broadway show (the lane covers nothing else)');
  const openMs = Date.parse(`${show.openingDate}T12:00:00Z`);
  if (!Number.isFinite(openMs) || nowMs - openMs <= MIN_PRESS_NIGHT_AGE_DAYS * DAY_MS) return none('recorded press night is not more than 2 days old, the normal press-night clock owns it');
  if (lease && lease.unknown) return none('lease store unreadable: cannot tell whether a lane is watching, nothing sent');
  if (lease) return none(`a lane lease is active (${lease.holder || 'lane'}): the show is watched`);

  const roundupDay = roundupDayFromUrl(roundupUrl);
  if (roundupDay) {
    const t = Date.parse(`${roundupDay}T12:00:00Z`);
    if (Number.isFinite(t) && t > openMs + MIN_PRESS_NIGHT_AGE_DAYS * DAY_MS && nowMs - t <= (RECENT_DAYS + 0.5) * DAY_MS) {
      return { action: 'route-coordinator', signal: 'bww-roundup', day: roundupDay, marker: alertMarker(show.id, roundupDay),
        reason: `BWW Review Roundup ${roundupUrl} is dated ${roundupDay}, ${Math.round((t - openMs) / DAY_MS)} days after the recorded press night ${show.openingDate}, and no lane is watching the show.` };
    }
  }
  const v = RL.lateEmbargoVerdict(show, reviews, nowMs, { tierOf });
  if (v.status === 'fail') {
    const day = (/dated (\d{4}-\d{2}-\d{2})/.exec(v.detail) || [])[1] || new Date(nowMs).toISOString().slice(0, 10);
    return { action: 'route-coordinator', signal: 'tier12-burst', day, marker: alertMarker(show.id, day), reason: v.detail };
  }
  return none(v.detail);
}

/** The Linear/Discord text for a routed decision. The remedy is a lane night, never reviewEmbargoAt (it cannot cover a later night). */
function alertText(show, decision) {
  const title = show.title || show.id;
  return [
    `${decision.marker}`,
    `Late press night: ${title} (${show.id}) is unwatched but shows a press-night signal (${decision.signal}, ${decision.day}).`,
    decision.reason,
    `The recorded press night ${show.openingDate} was the first performance, so there is no lane lease, night run or watchdog. A lane night is needed now: dispatch opening-night-lane-live.yml (mode=night, show=${show.id}) or ingest the missing reviews by hand (logged as manual).`,
    'Posted by the late press-night watch (BRO-7808).',
  ].join('\n');
}

module.exports = { decideLatePressNight, roundupDayFromUrl, alertMarker, alertText, MIN_PRESS_NIGHT_AGE_DAYS };
