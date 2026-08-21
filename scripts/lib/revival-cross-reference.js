'use strict';

const { isBroadwayCategory } = require('./venue-classification');

// Full normalized title (no subtitle stripping) to avoid false positives —
// e.g. "Seagull: True Story" should NOT match "The Seagull".
function normalizeTitle(t) {
  return t.toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// normalized title -> { type, id, category, title }
function buildExistingTitleMap(shows) {
  const map = new Map();
  for (const s of shows) {
    const norm = normalizeTitle(s.title);
    if (norm.length < 4) continue; // skip very short titles to avoid false matches (art, bug, etc.)
    if (!map.has(norm)) {
      map.set(norm, { type: s.type, id: s.id, category: s.category, title: s.title });
    }
  }
  return map;
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
  const norm = normalizeTitle(show.title);
  let match = existingTitleMap.get(norm);
  if (!match || match.id === show.id) {
    // Try base title (before colon, dash, or parens) — only if 5+ chars to avoid false positives
    const base = show.title.replace(/\s*[:(\-–—].*/g, '').trim();
    const normBase = normalizeTitle(base);
    if (normBase.length >= 5 && normBase !== norm) {
      match = existingTitleMap.get(normBase);
    }
  }
  if (!match || match.id === show.id) {
    return { isRevival: false, detectedType: null, confidence: null, match: null, isTransfer: false };
  }

  const normMarket = (cat) => isBroadwayCategory({ category: cat }) ? 'broadway' : cat;
  const sameMarket = normMarket(match.category) === normMarket(show.category);
  if (sameMarket) {
    return { isRevival: true, detectedType: match.type || null, confidence: 'high', match, isTransfer: false };
  }
  return { isRevival: false, detectedType: null, confidence: null, match, isTransfer: true };
}

module.exports = { normalizeTitle, buildExistingTitleMap, detectRevivalByTitleCrossReference };
