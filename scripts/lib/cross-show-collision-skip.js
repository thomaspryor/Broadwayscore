/**
 * Skip decision for audit-cross-show-url-collisions.js before it flags the
 * losing side of a shared-URL collision wrongShow (BRO-2261).
 *
 * Two of the old skips were too broad and let real contamination through:
 *   1. A null publishDate skipped the file even when the pipeline had already
 *      marked its body as junk (scraper_garbage, url_content_mismatch,
 *      wrong_content). That record has no date because its text is not the
 *      review, which is a reason to flag, not to protect.
 *   2. "London show + UK outlet URL" skipped every West End collision. A
 *      same-title earlier London production's review (Old Vic 2019 filed on
 *      the 2025 West End transfer) has a UK URL too. The skip now stands down
 *      when the review predates this show's earliest date by more than
 *      PRE_RUN_DAYS, when its own text does not name the show, or when its
 *      text names another same-title production's venue and not this one's.
 *
 * Pure: the caller passes everything in. Text and dates only, never URL
 * metadata (CLAUDE.md §3); the UK-outlet test is the caller's existing
 * market signal, unchanged.
 */
const { validateShowMentioned } = require('./content-quality');
const { earliestShowDate } = require('./date-guard');
const { toDateMs } = require('./date-utils');

const JUNK_BODY_REASONS = new Set(['scraper_garbage', 'url_content_mismatch', 'wrong_content']);
const PRE_RUN_DAYS = 180;
const MIN_TEXT = 200;
const DAY_MS = 86400000;

function venueNamed(text, venue) {
  if (!text || !venue || venue.length < 6) return false;
  const v = venue.toLowerCase().replace(/^the\s+/, '').replace(/\s+theatre$|\s+theater$/, '').trim();
  return v.length >= 4 && text.toLowerCase().includes(v);
}

/**
 * Why the London + UK-outlet skip should NOT apply, or null when it should.
 * @param {object} data   review file
 * @param {object} show   { id, title, venue, previewDate?, previewsStartDate?, openingDate? }
 * @param {object[]} sameTitleShows other productions with this title ({ id, venue })
 */
function londonSkipOverride(data, show, sameTitleShows = []) {
  const earliest = earliestShowDate(show);
  const pub = toDateMs(data.publishDate);
  if (earliest && !Number.isNaN(pub)) {
    const days = (toDateMs(earliest) - pub) / DAY_MS;
    if (days > PRE_RUN_DAYS) return `published ${Math.round(days)}d before this run's earliest date`;
  }
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  if (text.length >= MIN_TEXT) {
    if (!validateShowMentioned(text, show.title, show.id).valid) return 'review text never names this show';
    if (!venueNamed(text, show.venue)) {
      const other = sameTitleShows.find(o => o.id !== show.id && o.venue && o.venue !== show.venue && venueNamed(text, o.venue));
      if (other) return `text names ${other.id}'s venue (${other.venue}), not this show's`;
    }
  }
  return null;
}

/**
 * @param {object} p
 * @param {object} p.data            review file
 * @param {object|null} p.show       this show's record (see londonSkipOverride)
 * @param {object[]} [p.sameTitleShows]
 * @param {boolean} p.cleared        a human cleared wrongShow on this file
 * @param {boolean} p.londonUk       show is London-market and the URL is a UK outlet's
 * @param {boolean} p.urlMarketMatch the URL's market signal matches this show
 * @returns {{skip: boolean, reason: string}}
 */
function wrongShowSkipDecision({ data, show, sameTitleShows = [], cleared, londonUk, urlMarketMatch }) {
  if (cleared) return { skip: true, reason: 'manually cleared' };
  if (!data.publishDate && !JUNK_BODY_REASONS.has(data.incompleteReason)) {
    return { skip: true, reason: 'null publishDate, no date signal' };
  }
  if (show && londonUk) {
    const override = londonSkipOverride(data, show, sameTitleShows);
    if (!override) return { skip: true, reason: 'London market + UK outlet' };
    // fall through: the market signal alone cannot vouch for this file
    return { skip: false, reason: `London + UK skip overridden: ${override}` };
  }
  if (urlMarketMatch) return { skip: true, reason: 'URL market signal matches show' };
  if (show && typeof data.fullText === 'string' && data.fullText.length >= MIN_TEXT
      && validateShowMentioned(data.fullText, show.title, show.id).valid) {
    return { skip: true, reason: 'fullText confirms filed show' };
  }
  return { skip: false, reason: '' };
}

module.exports = { wrongShowSkipDecision, londonSkipOverride, JUNK_BODY_REASONS, PRE_RUN_DAYS };
