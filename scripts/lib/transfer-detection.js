'use strict';

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
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { isBroadwayCategory } = require('./venue-classification');

const TITLE_JACCARD_THRESHOLD = 0.8; // matches the OB promoter dedup threshold

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

module.exports = { detectTransferPairs, TITLE_JACCARD_THRESHOLD };
