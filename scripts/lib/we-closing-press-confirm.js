/**
 * we-closing-press-confirm.js (BRO-7993)
 *
 * Pure decision for a West End "new-closing candidate": no stored closingDate,
 * westendtheatre.com shows a "Booking until" date. That date is usually a
 * booking tranche for an open-ended run, so it is NOT applied on its own.
 * It is applied only when credible press (scripts/lib/closing-date-discovery.js,
 * fieldType 'closing-we') names an explicit final performance that agrees with
 * the booking date within toleranceDays. Anything else stays blank and files
 * nothing.
 *
 * @param {object} opts
 * @param {string|null} opts.stored       stored closingDate (must be null/blank to apply)
 * @param {string} opts.bookingDate       'YYYY-MM-DD' booking-page date
 * @param {object|null} opts.discovery    result of discoverWestEndClosingDate, or null
 * @param {string} opts.todayStr          'YYYY-MM-DD'
 * @param {number} [opts.toleranceDays=7]
 * @returns {{apply: boolean, date: string|null, reason: string, sources: object[]}}
 */
const { WEST_END_CREDIBLE_HOSTS, FIELD_CONFIGS } = require('./closing-date-discovery');

const EXPLICIT_FINAL = FIELD_CONFIGS['closing-we'].quoteAcceptanceRegex;
// A quote that is really a booking window must not count as a final performance.
const BOOKING_WINDOW = /booking (?:until|through|to)|on sale (?:until|through)|tickets? (?:are )?(?:available|on sale) (?:until|through)|book(?:ing)? now until/i;

function no(reason) { return { apply: false, date: null, reason, sources: [] }; }

function decideWeNewClosing(opts) {
  const { stored, bookingDate, discovery, todayStr, toleranceDays = 7 } = opts;
  if (stored) return no('already_has_closing_date');
  if (!bookingDate) return no('no_booking_date');
  if (!discovery || !discovery.date) return no('no_press_closing_found');

  const press = discovery.date;
  const gap = Math.abs(Math.round((new Date(press) - new Date(bookingDate)) / 86400000));
  if (gap > toleranceDays) return no(`press_disagrees_with_booking_page_${gap}d`);
  if (todayStr && press < todayStr) return no('press_date_in_past');

  const sources = (discovery.sources || []).filter(s => s && s.url);
  const explicit = sources.filter(s => {
    const q = (s.quote || '');
    return EXPLICIT_FINAL.test(q.toLowerCase()) && !BOOKING_WINDOW.test(q);
  });
  if (explicit.length === 0) return no('no_explicit_final_performance_quote');
  return { apply: true, date: press, reason: 'press_confirmed', sources: explicit };
}

module.exports = { decideWeNewClosing, WEST_END_CREDIBLE_HOSTS };
