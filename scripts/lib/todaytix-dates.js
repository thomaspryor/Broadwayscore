/**
 * One definition of "how much do we trust a TodayTix startDate".
 *
 * TodayTix sometimes reuses show IDs across productions, returning a future
 * date that looks legitimate but belongs to a different run. That broke the
 * pre-opening review guard and excluded valid reviews for Pen Pals (Aug 2025
 * listed vs Jan 2025 actual) and Take Me Out (Nov 2022 vs Apr 2022).
 *
 * The old rule dropped any startDate more than 120 days out. That protected
 * the review guard but destroyed the date, and TodayTix on its own genuinely
 * cannot distinguish a recycled ID from a subscription season announced early
 * — City Center Encores!, Roundabout, LCT and The Public all announce 6-10
 * months ahead. Losing the date then cascaded: with openingDate AND
 * previewsStartDate both null, downstream identity logic had nothing to work
 * with and the whole 2027 Encores! season either vanished or landed dateless
 * (2026-08-12).
 *
 * So the rule no longer decides which case it is. It decides only whether the
 * date is trusted enough to gate reviews on:
 *   - inside the window  → previewsStartDate (trusted, unchanged behaviour)
 *   - beyond the window  → unconfirmedStartDate (quarantined)
 *
 * Nothing that gates reviews reads unconfirmedStartDate — review-guards.js
 * anchors its run window on `previewsStartDate || openingDate` (:259, :574)
 * and never sees the quarantined field — so the original protection is
 * byte-identical. Only identity logic (the twin guard, the id year, the slug
 * year) reads it. And because the window is relative to today, a quarantined
 * date promotes itself into previewsStartDate on a later run once the show is
 * genuinely within ~4 months — no separate promotion pass, no new trust.
 *
 * NOTE (second-opinion review, 2026-08-12): an earlier draft also stamped
 * `provisional: true` + a custom discoverySource here. Don't. `provisional`
 * means *venue/classification* confidence in this codebase
 * (validate-data.js:529 says so outright), and validate-show-venue.js:110
 * turns it into a Playbill cross-check that test.yml runs as a BLOCKING
 * --fail-on-mismatch gate. A show whose Playbill page won't exist for months
 * fails that check on title-year mismatch, so the flag would have painted
 * main red on every push until opening. The venue here came from
 * resolveTodayTixVenue() like any other TodayTix show; only the date is
 * unconfirmed, and the date gates nothing.
 */

const TODAYTIX_TRUSTED_START_WINDOW_DAYS = 120;
const TODAYTIX_TRUSTED_START_WINDOW_MS = TODAYTIX_TRUSTED_START_WINDOW_DAYS * 86400000;

/**
 * @param {string|null|undefined} startDate  raw TodayTix startDate
 * @param {string} showTitle                 for the warning line only
 * @param {{ now?: number, quiet?: boolean }} [opts]
 * @returns {{ previewsStartDate: string|null, unconfirmedStartDate: string|null }}
 *   At most one is non-null.
 */
function classifyTodayTixStartDate(startDate, showTitle, opts = {}) {
  const none = { previewsStartDate: null, unconfirmedStartDate: null };
  if (!startDate) return none;
  const parsedMs = Date.parse(startDate);
  if (!Number.isFinite(parsedMs)) return none;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const diffMs = parsedMs - now;
  if (diffMs > TODAYTIX_TRUSTED_START_WINDOW_MS) {
    if (!opts.quiet) {
      console.warn(`  ⚠ TodayTix startDate for "${showTitle}" is ${Math.round(diffMs / 86400000)}d out — not trusted as previewsStartDate, quarantined as unconfirmedStartDate`);
    }
    return { previewsStartDate: null, unconfirmedStartDate: startDate };
  }
  return { previewsStartDate: startDate, unconfirmedStartDate: null };
}

/**
 * Fields to spread onto a show carrying a quarantined start date — just the
 * date, normalized to YYYY-MM-DD so downstream `.split('-')[0]` year extraction
 * is safe (the raw TodayTix string is not guaranteed ISO, and the id becomes a
 * file path at public/data/shows/{id}.json).
 *
 * See the header for why this deliberately does NOT set `provisional`.
 */
function unconfirmedStartFlags(unconfirmedStartDate) {
  const iso = normalizeIsoDate(unconfirmedStartDate);
  return iso ? { unconfirmedStartDate: iso } : {};
}

/** YYYY-MM-DD, or null if unparseable. */
function normalizeIsoDate(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().split('T')[0];
}

/**
 * The 4-digit year to name a production's id/slug with, or null when no date
 * source is trustworthy enough to name it. Callers fall back to the current
 * year only when this returns null — and must never let a non-year string
 * through, since ids become file paths.
 */
function productionIdYear(show) {
  for (const candidate of [show.openingDate, show.previewsStartDate, show.unconfirmedStartDate]) {
    const iso = normalizeIsoDate(candidate);
    if (iso) return iso.slice(0, 4);
  }
  return null;
}

module.exports = {
  TODAYTIX_TRUSTED_START_WINDOW_DAYS,
  TODAYTIX_TRUSTED_START_WINDOW_MS,
  classifyTodayTixStartDate,
  unconfirmedStartFlags,
  normalizeIsoDate,
  productionIdYear,
};
