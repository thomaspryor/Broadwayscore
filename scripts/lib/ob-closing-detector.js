/**
 * Pure decision functions for the Off-Broadway closing-date detector.
 *
 * Two independent signals feed the same report:
 *  1. Review-text sweep — regex-scan review fullText for closing-date
 *     boilerplate ("runs through <date>", "closes <date>", etc), resolve
 *     the year from the review's publishDate (never from URLs), and
 *     corroborate across reviews for the same show.
 *  2. TodayTix staleness diff — an OB show with a todaytixId that has
 *     dropped out of the daily showtimes feed for several consecutive
 *     checks is a candidate-closed signal.
 *
 * Exported so scripts/detect-ob-closings.js and the colocated test file
 * both call the same functions (CLAUDE.md §15 — never copy logic into tests).
 */

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_RE_FRAGMENT = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DOW_RE_FRAGMENT = '(?:Sun|Mon|Tue(?:s)?|Wed(?:nesday)?|Thu(?:rs)?|Fri|Sat)(?:day)?';

const TEXT_DATE_FRAGMENT = `(?:${DOW_RE_FRAGMENT}\\.?,?\\s+)?(?<month>${MONTH_RE_FRAGMENT})\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(?<year>\\d{4}))?`;
const NUMERIC_DATE_FRAGMENT = `(?<nmonth>\\d{1,2})\\/(?<nday>\\d{1,2})(?:\\/(?<nyear>\\d{2,4}))?`;

// Anchor phrases that signal a closing-date boilerplate sentence. Order matters:
// the longer "runs through/thru" and "limited run through" alternatives must be
// tried before the bare "through"/"thru" so the anchor captured in the quote is
// the fuller phrase when present.
const ANCHOR_FRAGMENT = '(?:runs?\\s+(?:through|thru)|limited\\s+run\\s+through|through|thru|closes?|final\\s+performances?)';

// A date must immediately follow the anchor (with only an optional connector
// word like "on"/"is"/"are" in between) for a match. This is what rejects
// "through the years" — "the" matches neither the month-name nor numeric
// date fragment, so the whole alternation fails at that position.
const MENTION_RE = new RegExp(
  `\\b(?<anchor>${ANCHOR_FRAGMENT})\\b(?:\\s+(?:on|is|are))?\\s+(?:${TEXT_DATE_FRAGMENT}|${NUMERIC_DATE_FRAGMENT})`,
  'gi'
);

/**
 * Scans fullText for closing-date boilerplate mentions. Returns raw mentions
 * with month/day parsed but year left unresolved (null) when the text omits it —
 * resolveMentionDate() fills that in from review context, never from a URL.
 */
function extractClosingDateMentions(fullText) {
  if (!fullText || typeof fullText !== 'string') return [];
  const mentions = [];
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const g = m.groups || {};
    let month, day, year;
    if (g.month) {
      month = MONTH_NAMES[g.month.toLowerCase().replace(/\.$/, '')];
      day = parseInt(g.day, 10);
      year = g.year ? parseInt(g.year, 10) : null;
    } else if (g.nmonth) {
      month = parseInt(g.nmonth, 10);
      day = parseInt(g.nday, 10);
      year = g.nyear ? normalizeTwoDigitYear(g.nyear) : null;
    } else {
      continue;
    }
    if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) continue;
    mentions.push({
      anchor: g.anchor,
      quote: m[0].trim(),
      month,
      day,
      year,
      index: m.index,
    });
    // Avoid zero-length-loop hazards; exec already advances past the match.
  }
  return mentions;
}

function normalizeTwoDigitYear(yearStr) {
  if (yearStr.length === 4) return parseInt(yearStr, 10);
  const twoDigit = parseInt(yearStr, 10);
  return 2000 + twoDigit;
}

/**
 * Resolves a mention's year using the review's publishDate when the mention
 * text has no explicit year. If the resulting date falls more than a few days
 * before the publish date, the boilerplate almost certainly refers to next
 * year's date (e.g. a Dec-published review saying "through Jan 5").
 *
 * Returns an ISO date string ("YYYY-MM-DD") or null if unresolvable
 * (no explicit year AND no publishDate to anchor against).
 */
function resolveMentionDate(mention, publishDateISO) {
  let year = mention.year;
  if (!year) {
    if (!publishDateISO) return null;
    const publishDate = new Date(`${publishDateISO}T00:00:00Z`);
    if (isNaN(publishDate.getTime())) return null;
    year = publishDate.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, mention.month - 1, mention.day));
    const diffDays = (candidate.getTime() - publishDate.getTime()) / 86400000;
    if (diffDays < -3) year += 1;
  }
  return `${year}-${String(mention.month).padStart(2, '0')}-${String(mention.day).padStart(2, '0')}`;
}

/**
 * Convenience wrapper: extract + resolve in one call. Returns
 * [{ isoDate, quote, anchor }] — mentions with an unresolvable year are dropped.
 */
function extractClosingDateCandidates(fullText, publishDateISO) {
  return extractClosingDateMentions(fullText)
    .map((mention) => {
      const isoDate = resolveMentionDate(mention, publishDateISO);
      if (!isoDate) return null;
      return { isoDate, quote: mention.quote, anchor: mention.anchor };
    })
    .filter(Boolean);
}

/**
 * Run length in weeks between two ISO dates, or null if either is invalid
 * or closing is not after opening.
 */
function runLengthWeeks(openingDateISO, closingDateISO) {
  if (!openingDateISO || !closingDateISO) return null;
  const opening = new Date(`${openingDateISO}T00:00:00Z`);
  const closing = new Date(`${closingDateISO}T00:00:00Z`);
  if (isNaN(opening.getTime()) || isNaN(closing.getTime())) return null;
  const diffDays = (closing.getTime() - opening.getTime()) / 86400000;
  if (diffDays <= 0) return null;
  return diffDays / 7;
}

/**
 * Corroborates closing-date candidates across a show's reviews and decides
 * whether to propose a closingDate.
 *
 * reviewMentions: [{ reviewId, isoDate, quote }] — one entry per detected
 * mention (a review can contribute 0, 1, or more).
 *
 * Proposes when:
 *  - 2+ reviews (distinct reviewIds) agree on the same isoDate → confidence 'high'
 *  - exactly 1 review contributes exactly 1 distinct isoDate, and the implied
 *    run length (openingDate → isoDate) is 1–10 weeks → confidence 'medium'
 * Otherwise returns null (including disagreement across reviews — that's
 * ambiguous, not confident, and is surfaced separately for human review).
 */
function aggregateClosingDateCandidates(showId, openingDateISO, reviewMentions) {
  if (!reviewMentions || reviewMentions.length === 0) return null;

  const byDate = new Map();
  for (const rm of reviewMentions) {
    if (!byDate.has(rm.isoDate)) byDate.set(rm.isoDate, []);
    byDate.get(rm.isoDate).push(rm);
  }

  let best = null;
  for (const [isoDate, mentions] of byDate) {
    const distinctReviews = new Set(mentions.map((m) => m.reviewId)).size;
    if (!best || distinctReviews > best.distinctReviews) {
      best = { isoDate, mentions, distinctReviews };
    }
  }

  if (best.distinctReviews >= 2) {
    return {
      showId,
      proposedClosingDate: best.isoDate,
      confidence: 'high',
      reason: `${best.distinctReviews} reviews agree`,
      evidence: best.mentions,
    };
  }

  if (byDate.size === 1 && best.distinctReviews === 1) {
    const weeks = runLengthWeeks(openingDateISO, best.isoDate);
    if (weeks !== null && weeks >= 1 && weeks <= 10) {
      return {
        showId,
        proposedClosingDate: best.isoDate,
        confidence: 'medium',
        reason: `single review, ${weeks.toFixed(1)}wk implied run length`,
        evidence: best.mentions,
      };
    }
  }

  return null;
}

/**
 * Updates the consecutive-missing-checks state for the TodayTix staleness
 * diff. Called once per detector run (weekly cron).
 *
 * prevState: { [showId]: { consecutiveMissingChecks, firstMissingDate, lastCheckedDate } }
 * candidateShowIds: ids of open OB shows that carry a todaytixId
 * presentShowIds: Set of ids currently present in data/todaytix-showtimes.json
 *
 * Shows that reappear in the feed are dropped from the next state (reset).
 */
function updateTodayTixMissingState(prevState, candidateShowIds, presentShowIds, todayISO) {
  const nextState = {};
  for (const showId of candidateShowIds) {
    if (presentShowIds.has(showId)) continue;
    const prev = prevState[showId];
    if (prev) {
      nextState[showId] = {
        consecutiveMissingChecks: prev.consecutiveMissingChecks + 1,
        firstMissingDate: prev.firstMissingDate,
        lastCheckedDate: todayISO,
      };
    } else {
      nextState[showId] = {
        consecutiveMissingChecks: 1,
        firstMissingDate: todayISO,
        lastCheckedDate: todayISO,
      };
    }
  }
  return nextState;
}

/**
 * Decides which entries in the (updated) missing-state cross the
 * consecutive-checks threshold and should be surfaced as candidate-closed.
 * Default threshold is 2 consecutive weekly checks (~2 weeks stale) —
 * tolerates a single feed hiccup without flagging.
 */
function decideTodayTixCandidates(state, thresholdChecks = 2) {
  return Object.entries(state)
    .filter(([, v]) => v.consecutiveMissingChecks >= thresholdChecks)
    .map(([showId, v]) => ({
      showId,
      consecutiveMissingChecks: v.consecutiveMissingChecks,
      firstMissingDate: v.firstMissingDate,
    }));
}

/**
 * Suppression guard for proposals the weekly alert should NOT surface.
 * Returns a reason string, or null when the candidate is actionable.
 *
 *  - 'already-has-closing-date': shows.json already carries a closingDate —
 *    review-era dates are frequently superseded by extensions (Heathers was
 *    extended Jan→Nov 2026; Dad Don't Read This Jul 11→18), so an existing
 *    date always outranks review boilerplate. Never propose overwrites.
 *  - 'stale-evidence': the proposed date is more than a year in the past for
 *    a show still marked open. A truly stale-open show gets caught within
 *    weeks; a year-old "runs through" quote on an open show means the run
 *    extended or went open-ended (Little Shop of Horrors 2019 revival's
 *    "through Jan 19" 2020 quotes).
 */
function shouldSuppressCandidate(show, proposedClosingDateISO, todayISO) {
  if (show && show.closingDate) return 'already-has-closing-date';
  if (proposedClosingDateISO && todayISO) {
    const proposed = new Date(`${proposedClosingDateISO}T00:00:00Z`);
    const today = new Date(`${todayISO}T00:00:00Z`);
    if ((today - proposed) / 86400000 > 365) return 'stale-evidence';
  }
  return null;
}

module.exports = {
  MONTH_NAMES,
  extractClosingDateMentions,
  resolveMentionDate,
  extractClosingDateCandidates,
  runLengthWeeks,
  aggregateClosingDateCandidates,
  shouldSuppressCandidate,
  updateTodayTixMissingState,
  decideTodayTixCandidates,
};
