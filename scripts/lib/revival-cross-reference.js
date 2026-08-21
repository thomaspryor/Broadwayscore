'use strict';

const { isBroadwayCategory } = require('./venue-classification');
const { foldDiacritics } = require('./title-match');

// Full normalized title (no subtitle stripping) to avoid false positives —
// e.g. "Seagull: True Story" should NOT match "The Seagull". foldDiacritics
// BEFORE the [^a-z0-9' ] strip — otherwise an accented title (e.g. "Amélie")
// loses its accented letters entirely instead of folding to ASCII, so it can
// never cross-reference against an unaccented shows.json entry (or vice
// versa) — same class of bug documented across every other title matcher in
// this codebase (tests/unit/sibling-matchers-diacritics.test.mjs).
function normalizeRevivalTitle(t) {
  return foldDiacritics(t || '').toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// normalized title -> array of { type, id, category, title }. Keeps every
// same-title entry, not just the first seen — a title can legitimately exist
// in more than one market (e.g. a West End original + an unrelated same-name
// Broadway show), and picking only the first meant a same-market prior
// production could be shadowed by an earlier cross-market one and misread as
// a transfer instead of a revival (ship-check finding, ties to BRO-2023's own
// "wrong direction" theme).
function buildExistingTitleMap(shows) {
  const map = new Map();
  for (const s of shows) {
    const norm = normalizeRevivalTitle(s.title);
    if (norm.length < 4) continue; // skip very short titles to avoid false matches (art, bug, etc.)
    if (!map.has(norm)) map.set(norm, []);
    map.get(norm).push({ type: s.type, id: s.id, category: s.category, title: s.title });
  }
  return map;
}

// Broadway is stored 3 ways in shows.json (absent key / null / 'broadway'
// string, per isBroadwayCategory's own doc comment) — fold through that
// predicate so a legacy null-category entry compares equal to an explicit
// 'broadway' one instead of being misread as cross-market.
function normMarket(cat) {
  return isBroadwayCategory({ category: cat }) ? 'broadway' : cat;
}

// Among same-titled candidates (excluding the show itself), prefer a
// same-market one — that's the one that actually proves a revival.
function pickBestMatch(candidates, show) {
  if (!candidates || !candidates.length) return null;
  const others = candidates.filter(c => c.id !== show.id);
  if (!others.length) return null;
  const showMarket = normMarket(show.category);
  return others.find(c => normMarket(c.category) === showMarket) || others[0];
}

/**
 * Cross-reference a newly discovered show's title against existing shows.json
 * entries (BRO-2023). A same-title match in a DIFFERENT market (e.g. a West
 * End production transferring to Broadway, like Inter Alia 2026) is a
 * transfer, not a revival — only a same-market match is real revival
 * evidence. (Inter Alia Broadway shipped isRevival:true 2026-08-14 solely
 * because the West End "Inter Alia" entry already existed in shows.json.)
 *
 * Broadway is stored 3 ways in shows.json (absent key / null / 'broadway'
 * string, per isBroadwayCategory's own doc comment) — compare via that
 * predicate rather than raw === so a match against a null/'broadway' legacy
 * entry isn't wrongly treated as cross-market.
 */
function detectRevivalByTitleCrossReference(show, existingTitleMap) {
  const norm = normalizeRevivalTitle(show.title);
  let match = pickBestMatch(existingTitleMap.get(norm), show);
  if (!match) {
    // Try base title (before colon, dash, or parens) — only if 5+ chars to avoid false positives
    const base = show.title.replace(/\s*[:(\-–—].*/g, '').trim();
    const normBase = normalizeRevivalTitle(base);
    if (normBase.length >= 5 && normBase !== norm) {
      match = pickBestMatch(existingTitleMap.get(normBase), show);
    }
  }
  if (!match) {
    return { isRevival: false, detectedType: null, confidence: null, match: null, isTransfer: false };
  }

  const sameMarket = normMarket(match.category) === normMarket(show.category);
  if (sameMarket) {
    return { isRevival: true, detectedType: match.type || null, confidence: 'high', match, isTransfer: false };
  }
  return { isRevival: false, detectedType: null, confidence: null, match, isTransfer: true };
}

module.exports = { normalizeRevivalTitle, buildExistingTitleMap, detectRevivalByTitleCrossReference };
