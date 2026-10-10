'use strict';
// venue-write-guard-ok: detectLondonTransferPairs copies an EXISTING row's venue into a priorRuns suggestion that is only printed, never written (S5-T5: humans add the link).

/**
 * Regional→Broadway transfer detection (pure, no IO — CLAUDE.md §15).
 *
 * A tracked regional tryout (category:'regional') whose title matches a
 * Broadway show that opened AFTER the tryout is (almost certainly) that
 * show's Broadway transfer. Detecting the pair automatically means the
 * cross-links + tryout-score line (transferOf/transferredTo, 2026-07-11)
 * appear without anyone watching announcements.
 *
 * Safety posture:
 *  - Date direction: the Broadway opening (or previews start) must be AFTER
 *    the regional opening. A regional staging of an old Broadway title
 *    (someone revives "Rent" at the Goodman) points backwards in time and is
 *    NEVER linked.
 *  - Ambiguity: two candidate Broadway productions (revival + original both
 *    post-dating the tryout) → no pair. Humans handle rare cases.
 *  - Idempotent: shows already carrying transferredTo / transferOf are
 *    skipped on their respective sides.
 *
 * Driver: scripts/detect-regional-transfers.js (applies pairs + emails).
 *
 * London transfers / return engagements (BRO-4204 S5-T5) — see
 * detectLondonTransferPairs below. Those are SUGGESTIONS only: the driver
 * prints a ready-to-paste `priorRuns[]` entry for the later row and writes
 * nothing, because validate-data reserves transferOf/transferredTo for
 * regional tryouts (transferOf must point at a category:'regional' row).
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { isBroadwayCategory, isLondonMarket } = require('./venue-classification');
// deduplication.js requires venue-classification, title-match, text-cleaning,
// show-duplicate-detection and market-slug — none of them require this
// module, so there is no cycle.
const {
  normalizeTitle: dedupNormalizeTitle,
  venuesMatch,
  isCrossLinked,
  NEW_PRODUCTION_VENUE_GAP_DAYS,
} = require('./deduplication');

const TITLE_JACCARD_THRESHOLD = 0.8; // matches the OB promoter dedup threshold

// A same-title London row at another house starting within this many days
// of the earlier row's close is that row's transfer/return. Shares the S5-T1
// threshold: deduplication.js treats a same-title row at a different venue
// 120+ days on as a new production; this is the matching "and here is which
// production it continues" side of the same line.
const LONDON_TRANSFER_WINDOW_DAYS = NEW_PRODUCTION_VENUE_GAP_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

function _titleMatches(a, b) {
  if (!a || !b) return false;
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  return jaccard(ta, tb) >= TITLE_JACCARD_THRESHOLD;
}

function _dateOf(show) {
  const d = show.openingDate || show.previewsStartDate || null;
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {Array<Object>} shows - full shows.json array
 * @returns {Array<{regionalId: string, broadwayId: string, reason: string}>}
 */
function detectTransferPairs(shows) {
  const list = Array.isArray(shows) ? shows : [];
  const regionals = list.filter(s => s && s.category === 'regional' && !s.transferredTo);
  // "Broadway" = default-market shows (category absent or 'broadway').
  const broadway = list.filter(s => s && isBroadwayCategory(s) && !s.transferOf);

  const pairs = [];
  for (const r of regionals) {
    const rDate = _dateOf(r);
    if (!rDate) continue; // no date anchor — direction check impossible, skip
    const candidates = broadway.filter(b => {
      if (!_titleMatches(r.title, b.title)) return false;
      const bDate = _dateOf(b);
      return bDate !== null && bDate > rDate;
    });
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        pairs.push({ regionalId: r.id, broadwayId: null, reason: `ambiguous: ${candidates.map(c => c.id).join(', ')}` });
      }
      continue;
    }
    pairs.push({ regionalId: r.id, broadwayId: candidates[0].id, reason: 'title match, Broadway opening postdates tryout' });
  }
  return pairs;
}

// London titles: the regional matcher's title-match.js rule, OR
// deduplication.js's normalizeTitle equality, which strips a trailing
// " - <venue tag>" ("Pride - Bridge Theatre" ≡ "Pride"). Discovery mints
// venue-tagged titles for a same-title second London row precisely because
// the bare title already exists, so the regional rule alone misses every
// transfer this detector is for. The extra looseness is acceptable here
// because the output is a suggestion, never a write.
function _londonTitleMatches(a, b) {
  if (!a || !b) return false;
  if (_titleMatches(a, b)) return true;
  const na = dedupNormalizeTitle(a);
  return na.length >= 3 && na === dedupNormalizeTitle(b);
}

function _parseMs(value) {
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Earliest start the later row carries — previews precede opening, and a
// quarantined unconfirmedStartDate is all an early-announced season has.
function _startOf(show) {
  const starts = [show.previewsStartDate, show.unconfirmedStartDate, show.openingDate]
    .map(_parseMs).filter(ms => ms !== null);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * Same-title London rows (west-end / off-west-end) at DIFFERENT venues where
 * the later row starts within LONDON_TRANSFER_WINDOW_DAYS after the earlier
 * row closed: a West End transfer (Bridge → Noël Coward, Old Vic → Duke of
 * York's) or a return engagement (Dorfman → Bridge). Emits, for the LATER
 * row, the `priorRuns[]` entry that names the earlier row by id — the shape
 * src/types/show.ts's PriorRun declares and deduplication.js's isCrossLinked
 * reads — so the two rows stop reading as duplicates and the later page can
 * cite the earlier run.
 *
 * Safety posture mirrors detectTransferPairs:
 *  - Direction: the later start must be strictly AFTER the earlier close;
 *    an overlapping or earlier run is never a transfer of the other.
 *  - Window: more than LONDON_TRANSFER_WINDOW_DAYS after the close is a
 *    revival, not a transfer — no suggestion.
 *  - Venue: both venues must be present and NOT match (venuesMatch handles
 *    aliases); a same-venue pair is a return the venue itself will list,
 *    and the S5-T1 rule already keeps it from deduping.
 *  - Idempotent: a later row whose priorRuns (or transferOf/transferredTo)
 *    already names the earlier id is skipped (isCrossLinked).
 *  - Ambiguity: two earlier rows both closing inside the window before one
 *    later row → reported with earlierId null, never suggested.
 *
 * @param {Array<Object>} shows - full shows.json array
 * @returns {Array<{earlierId: string|null, laterId: string, suggestedPriorRun: Object|null, reason: string}>}
 */
function detectLondonTransferPairs(shows) {
  const list = Array.isArray(shows) ? shows : [];
  const london = list.filter(s => s && s.id && s.title && isLondonMarket(s.category) && s.venue);

  const results = [];
  for (const later of london) {
    const laterStart = _startOf(later);
    if (laterStart === null) continue; // no start anchor — direction check impossible
    const earlierRuns = london.filter(earlier => {
      if (earlier === later || earlier.id === later.id) return false;
      const earlierClose = _parseMs(earlier.closingDate);
      if (earlierClose === null) return false;
      const gapDays = (laterStart - earlierClose) / DAY_MS;
      if (gapDays <= 0 || gapDays > LONDON_TRANSFER_WINDOW_DAYS) return false;
      if (venuesMatch(earlier.venue, later.venue)) return false;
      if (!_londonTitleMatches(earlier.title, later.title)) return false;
      return !isCrossLinked(earlier, later);
    });
    if (earlierRuns.length === 0) continue;
    if (earlierRuns.length > 1) {
      results.push({
        earlierId: null,
        laterId: later.id,
        suggestedPriorRun: null,
        reason: `ambiguous: ${earlierRuns.map(e => e.id).join(', ')} all closed within ${LONDON_TRANSFER_WINDOW_DAYS}d before ${later.id} starts`,
      });
      continue;
    }
    const earlier = earlierRuns[0];
    const gapDays = Math.round((laterStart - _parseMs(earlier.closingDate)) / DAY_MS);
    const suggestedPriorRun = { id: earlier.id, venue: earlier.venue };
    if (earlier.openingDate) suggestedPriorRun.openingDate = earlier.openingDate;
    suggestedPriorRun.closingDate = earlier.closingDate;
    results.push({
      earlierId: earlier.id,
      laterId: later.id,
      suggestedPriorRun,
      reason: `same title, different London venue, starts ${gapDays}d after ${earlier.id} closed`,
    });
  }
  return results;
}

module.exports = { detectTransferPairs, detectLondonTransferPairs, TITLE_JACCARD_THRESHOLD, LONDON_TRANSFER_WINDOW_DAYS };
