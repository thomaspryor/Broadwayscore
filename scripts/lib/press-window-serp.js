/**
 * BRO-6762 hole 2: off-Broadway / off-West-End press-night SERP window.
 *
 * pollMode gives OB/OWE no aggressive window (their reviews trickle over weeks), so
 * after opening they got one SERP slot a day (the morning slot) and the first
 * reviews, which land the evening of and the morning after press night, waited for it.
 * This adds ONE extra evening slot a day for the first 3 days after opening. It is
 * a cadence change only: each run is still bounded by SERP_BUDGET and the SERP session
 * caps, and it needs no aggressive mode, so the burst machinery is untouched.
 * Kill switch: DISABLE_OB_PRESS_WINDOW_SERP=true.
 */
const PRESS_WINDOW_MARKETS = {
  // UTC hours accepted for the extra slot (cron delay of 1-2h included).
  'off-broadway': { startHour: 21, endHour: 23 },     // ~5-7pm ET, as reviews post
  'off-west-end': { startHour: 16, endHour: 19 },     // ~5-8pm BST
};
const MAX_SESSIONS_PER_DAY = 2;
const PRESS_WINDOW_HOURS = { from: 6, to: 78 };       // after opening time

function isPressWindowSerpSlot(show, now = new Date(), env = process.env, sessionsToday = 0) {
  if (env.DISABLE_OB_PRESS_WINDOW_SERP === 'true') return false;
  const cat = (show && (show.category || show.market)) || '';
  const slot = PRESS_WINDOW_MARKETS[cat];
  if (!slot || !show.openingDate) return false;
  // At most MAX_SESSIONS_PER_DAY SERP sessions a show per UTC day (the morning slot plus this one),
  // so the 2-3h window cannot fan out across every poller run and eat the shared daily cap.
  if (sessionsToday >= MAX_SESSIONS_PER_DAY) return false;
  const h = (now.getTime() - new Date(show.openingDate).getTime()) / 3600000;
  if (!(h >= PRESS_WINDOW_HOURS.from && h < PRESS_WINDOW_HOURS.to)) return false;
  const hour = now.getUTCHours();
  return hour >= slot.startHour && hour <= slot.endHour;
}

module.exports = { isPressWindowSerpSlot, MAX_SESSIONS_PER_DAY, PRESS_WINDOW_MARKETS, PRESS_WINDOW_HOURS };
