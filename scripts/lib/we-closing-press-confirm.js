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
const BOOKING_WINDOW = /(?:booking|sale|offer|lottery|rush|ticket\w*)\s+(?:closes?|ends?)|booking (?:until|through|to)|on sale (?:until|through)|tickets? (?:are )?(?:available|on sale) (?:until|through)|book(?:ing)? now until/i;

// A cast member's last night is not the production's closing.
const CAST_DEPARTURE = /\b(?:her|his|their|its star's)\s+(?:last|final)\s+performance|\b(?:cast|star|stars|leaves|leaving|departs?|departure|exits?|replac\w+|final (?:week|weeks) for)\b/i;

function no(reason) { return { apply: false, date: null, reason, sources: [] }; }

function decideWeNewClosing(opts) {
  const { stored, bookingDate, discovery, todayStr, toleranceDays = 7 } = opts;
  if (stored) return no('already_has_closing_date');
  if (!bookingDate) return no('no_booking_date');
  if (!discovery || !discovery.date) return no('no_press_closing_found');

  const press = discovery.date;
  const gap = Math.abs(Math.round((new Date(press) - new Date(bookingDate)) / 86400000));
  if (!Number.isFinite(gap)) return no('bad_date');
  if (gap > toleranceDays) return no(`press_disagrees_with_booking_page_${gap}d`);
  if (todayStr && press < todayStr) return no('press_date_in_past');

  // The evidence must be a single source whose OWN date is within tolerance of
  // the booking date, whose quote is an explicit final-performance statement,
  // names that date's day number, and is not a cast departure / booking window.
  // The date written is that source's date, not the cluster centre.
  const sources = (discovery.sources || []).filter(s => s && s.url);
  const explicit = sources.filter(s => {
    const q = s.quote || '';
    const d = s.date || press;
    if (Math.abs(Math.round((new Date(d) - new Date(bookingDate)) / 86400000)) > toleranceDays) return false;
    if (!EXPLICIT_FINAL.test(q.toLowerCase()) || BOOKING_WINDOW.test(q) || CAST_DEPARTURE.test(q)) return false;
    const day = String(parseInt(d.slice(8, 10), 10));
    return new RegExp(`(^|\\D)${day}(st|nd|rd|th)?(\\D|$)`).test(q);
  });
  if (explicit.length === 0) return no('no_explicit_final_performance_quote');
  const date = explicit[0].date || press;
  return { apply: true, date, reason: 'press_confirmed', sources: explicit };
}

module.exports = { decideWeNewClosing, WEST_END_CREDIBLE_HOSTS };
