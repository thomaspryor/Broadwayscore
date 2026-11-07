'use strict';

/**
 * Pure press-night count rule for the Express same-night retry (BRO-5953).
 *
 * Billy Crystal 860 (2026-10-20): the Express auto-run reported "1/1 scoreable",
 * shouldRetryExpress() judged that ratio not thin, and no retry was queued. One
 * review is not a press night. Inside a show's press-night window
 * (opening-night-windows.js computeWindow), fewer than MIN_PRESS_NIGHT_SCORED
 * scored reviews is a retry, whatever the real-text ratio says. The retry cap is
 * the existing one: a run that is itself a retry never re-enqueues.
 */

const MIN_PRESS_NIGHT_SCORED = 3;

// Inside the window reviews are landing now; the 16h early-fire delay could land after it closes.
const PRESS_NIGHT_RETRY_DELAY_HOURS = 2;

/**
 * @param {object} args
 * @param {number} args.scoredCount scored (includable) reviews for the show
 * @param {{windowStart: Date, windowEnd: Date}|null} args.window computeWindow() result
 * @param {Date} [args.now]
 * @param {boolean} [args.isRetry] this run is itself a queued retry
 * @param {number} [args.minScored]
 * @returns {{retry: boolean, reason: string}}
 */
function shouldRetryForThinPressNight({ scoredCount, window, now = new Date(), isRetry = false, minScored = MIN_PRESS_NIGHT_SCORED }) {
  if (isRetry) return { retry: false, reason: 'run is already a retry (cap reached)' };
  if (!window || !window.windowStart || !window.windowEnd) return { retry: false, reason: 'no press-night window' };
  if (now < window.windowStart || now > window.windowEnd) return { retry: false, reason: 'outside press-night window' };
  const n = Number(scoredCount) || 0;
  if (n >= minScored) return { retry: false, reason: `${n} scored reviews meets the press-night minimum of ${minScored}` };
  return { retry: true, reason: `only ${n} scored review(s) inside the press-night window (minimum ${minScored})` };
}

module.exports = { MIN_PRESS_NIGHT_SCORED, PRESS_NIGHT_RETRY_DELAY_HOURS, shouldRetryForThinPressNight };
