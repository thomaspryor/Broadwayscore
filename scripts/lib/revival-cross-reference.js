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
    map.get(norm).push({ type: s.type, id: s.id, category: s.category, title: s.title, creativeTeam: s.creativeTeam });
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

// Score credits (music, lyrics) and play-author credits only. "Book" is left
// out on purpose: revivals often get a new book writer (The Last Ship 2026
// has Joe DiPietro where 2014 had Logan/Yorkey) while the score stays. Music
// direction, orchestration and arranging are not authorship.
const SCORE_ROLE = /\b(music|lyrics?|lyricist|composer)\b/i;
// Removed from a role string before matching, so "Music & Lyrics, Music Director"
// still counts as a score credit while "Music Direction" alone does not.
const NOT_AUTHORSHIP = /\b(?:music(?:al)? (?:direction|director|supervision|supervisor|arrangements?|arranger)|orchestrations?|orchestrator|arrangements?|conductor|co-?director|director)\b/gi;
const BOOK_ROLE = /\bbook\b/i;
const PLAY_ROLE = /^(?!.*\bbook\b).*\b(playwright|written by|writer|author)\b/i; // "Book Writer" is a book credit

function creditNames(creativeTeam, roleRe) {
  const out = new Set();
  for (const c of Array.isArray(creativeTeam) ? creativeTeam : []) {
    const role = String((c && c.role) || '').replace(NOT_AUTHORSHIP, ' ');
    if (!c || !c.name || !roleRe.test(role)) continue;
    // IBDB packs credits as "A and B" / "A, B"
    for (const part of String(c.name).split(/\s*(?:,|&|\band\b)\s*/i)) {
      const n = foldDiacritics(part).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
      // Surname only: the same author is credited as "G. B. Shaw", "Bernard
      // Shaw" and "George Bernard Shaw" across IBDB, Playbill and listings.
      // ue/oe/ae collapse so "Dürrenmatt" (folds to durrenmatt) equals "Duerrenmatt".
      const surname = n.split(' ').pop().replace(/([aou])e/g, '$1');
      if (surname && surname.length > 2) out.add(surname);
    }
  }
  return out;
}

/**
 * True only when both records carry a core authorship credit (music/lyrics or
 * a play's author) and NO author-ish credit of any kind (book included) is
 * shared. A shared name anywhere means the same work (noisy roles such as a
 * book writer filed as "Composer" still match); a revised book alone, or a
 * side with no credits yet, is never a conflict. Same-title different-authors
 * is two unrelated works, not a revival.
 */
function writersConflict(a, b) {
  const coreA = new Set([...creditNames(a, SCORE_ROLE), ...creditNames(a, PLAY_ROLE)]);
  const coreB = new Set([...creditNames(b, SCORE_ROLE), ...creditNames(b, PLAY_ROLE)]);
  if (!coreA.size || !coreB.size) return false;
  const allA = new Set([...coreA, ...creditNames(a, BOOK_ROLE)]);
  const allB = new Set([...coreB, ...creditNames(b, BOOK_ROLE)]);
  for (const n of allA) if (allB.has(n)) return false;
  return true;
}

// Listings and press copy call a never-before-seen work "a new musical" /
// "world premiere". Revival copy says "revival" or "new production", so an
// explicit new-work phrase without the word "revival" is evidence against a
// title-only revival match.
const NEW_WORK_PHRASE = /\b(?:new (?:original )?(?:musical|play|comedy|drama|opera|rock musical|indie pop musical)|world[- ]premiere|brand[- ]new (?:musical|play))(?![-\w])/i;

function describesNewWork(show) {
  const text = [show && show.description, show && show.synopsis].filter(Boolean).join(' ');
  return NEW_WORK_PHRASE.test(text) && !/\brevival\b/i.test(text);
}

/**
 * Single decision for the IBDB prior-production checks (discover Stage 3 and
 * the detect-revivals-ibdb backfill): an IBDB title match counts as a revival
 * unless the show's own copy says it is a new work. Discovery rows have no
 * creative team yet, so authors cannot be compared on this path.
 */
function shouldAcceptIbdbRevival(result, show) {
  return !!(result && result.isRevival) && !describesNewWork(show);
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
  const lookup = (key) => {
    const others = (existingTitleMap.get(key) || []).filter(c => c.id !== show.id);
    // A title match alone cannot tell a revival from an unrelated work that
    // shares the name. Candidates whose authors differ are dropped one by one,
    // so a genuine earlier production is still found behind an unrelated one.
    const compatible = others.filter(c => !writersConflict(show.creativeTeam, c.creativeTeam));
    return { match: pickBestMatch(compatible, show), collided: others.length > 0 && compatible.length === 0, first: others[0] || null };
  };
  const none = { isRevival: false, detectedType: null, confidence: null, match: null, isTransfer: false };

  const fullKey = normalizeRevivalTitle(show.title);
  let { match, collided, first } = lookup(fullKey);
  if (!match && !collided) {
    // Try base title (before colon, dash, or parens) — only if 5+ chars to avoid false positives
    const base = show.title.replace(/\s*[:(\-–—].*/g, '').trim();
    const normBase = normalizeRevivalTitle(base);
    if (normBase.length >= 5 && normBase !== fullKey) {
      ({ match, collided, first } = lookup(normBase));
    }
  }
  if (!match && !collided) return none;

  // Different authors, or the show's own copy says "new musical" / "world premiere".
  if (collided || describesNewWork(show)) {
    const m = match || first;
    return { ...none, match: m, isTransfer: normMarket(m.category) !== normMarket(show.category), rejected: 'title-collision' };
  }

  const sameMarket = normMarket(match.category) === normMarket(show.category);
  if (sameMarket) {
    return { isRevival: true, detectedType: match.type || null, confidence: 'high', match, isTransfer: false };
  }
  return { isRevival: false, detectedType: null, confidence: null, match, isTransfer: true };
}

module.exports = { normalizeRevivalTitle, buildExistingTitleMap, detectRevivalByTitleCrossReference, writersConflict, describesNewWork, shouldAcceptIbdbRevival };
