/**
 * Pure decision function for the publish-date wrongProduction guard.
 *
 * Extracted from scripts/flag-wrong-production-by-date.js (2026-05-25) so the
 * guard's behavior — especially the UK-trusted-critic grace-period override —
 * can be unit-tested without I/O. Per project rule 15: test the real function.
 *
 * @param {object} args
 * @param {Date} args.pubDate - parsed publish date of the review
 * @param {object} args.show - the show record (uses previewDate / previewsStartDate / openingDate, closingDate, category/market)
 * @param {string|null} args.outletId - outletId on the review
 * @returns {{ flag: boolean, issue: 'before_preview'|'after_close'|null, diffDays: number, daysAllowedBefore: number }}
 */
// Exported so the calling script can use the same constants in log messages
// without drift. See scripts/flag-wrong-production-by-date.js.
const DAYS_BEFORE_PREVIEW = 21;
const DAYS_AFTER_CLOSE = 7;
const UK_DAYS_BEFORE_PREVIEW = 35;

function evaluateDateGuard({ pubDate, show, outletId }) {
  // NOTE: 'observer' deliberately excluded. observer.com is flagged
  // isDualMarket:true in outlet-registry.json — both NY Observer (US/Broadway
  // critics like David Cote) and The Observer UK share the outletId. Giving
  // them a 35d UK grace on WE shows would widen the wrongProduction window
  // in the wrong direction for the US-side reviews. Dual-market routing
  // handles them separately.
  const UK_TRUSTED_OUTLETS = new Set([
    'thestage', 'financialtimes', 'guardian', 'times-uk', 'telegraph',
    'standard', 'bbc', 'whatsonstage', 'independent',
  ]);
  const UK_MARKETS = new Set(['west-end', 'off-west-end']);

  const earliestStr = show.previewDate || show.previewsStartDate || show.openingDate;
  if (!earliestStr) return { flag: false, issue: null, diffDays: 0, daysAllowedBefore: DAYS_BEFORE_PREVIEW };

  const isUkMarket = UK_MARKETS.has(show.category) || UK_MARKETS.has(show.market);
  const isUkTrustedOutlet = outletId && UK_TRUSTED_OUTLETS.has(String(outletId).toLowerCase());
  const daysAllowedBefore = (isUkMarket && isUkTrustedOutlet) ? UK_DAYS_BEFORE_PREVIEW : DAYS_BEFORE_PREVIEW;

  const windowStart = new Date(earliestStr);
  windowStart.setDate(windowStart.getDate() - daysAllowedBefore);

  let windowEnd = null;
  if (show.closingDate) {
    windowEnd = new Date(show.closingDate);
    windowEnd.setDate(windowEnd.getDate() + DAYS_AFTER_CLOSE);
  }

  if (pubDate < windowStart) {
    return {
      flag: true,
      issue: 'before_preview',
      diffDays: Math.round((windowStart - pubDate) / 86400000),
      daysAllowedBefore,
    };
  }
  if (windowEnd && pubDate > windowEnd) {
    return {
      flag: true,
      issue: 'after_close',
      diffDays: Math.round((pubDate - windowEnd) / 86400000),
      daysAllowedBefore,
    };
  }
  return { flag: false, issue: null, diffDays: 0, daysAllowedBefore };
}

module.exports = { evaluateDateGuard, DAYS_BEFORE_PREVIEW, DAYS_AFTER_CLOSE, UK_DAYS_BEFORE_PREVIEW };
