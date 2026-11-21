'use strict';

/**
 * award-category-canonical.js
 *
 * Collapses synonym variants of the SAME award within a single ceremony so they
 * stop double-counting (in awards-scoring) and double-displaying (on show pages).
 *
 * The bug this fixes (forum report 2026-05-24): a Drama Desk / Outer Critics
 * Circle node listing BOTH "Outstanding Direction of a Musical" AND "Outstanding
 * Director of a Musical" — the same single award scraped under two name variants.
 * Same class: OCC "(Broadway or Off-Broadway)" parenthetical variants, and Drama
 * League "Distinguished Performance" vs "Distinguished Performance Award".
 *
 * Per-ceremony, because the official name differs by awarding body:
 *   - Drama Desk / Outer Critics Circle: official is "...Director of a..."
 *   - Drama League: official is "Distinguished Performance Award" (the chip logic
 *     in data-tony-predictions.ts pins this exact string + winnerNames).
 *   - Tony / Drama League "...Direction of a..." are the correct names there and
 *     are intentionally NOT rewritten.
 *
 * CRITICAL — preserve legitimate repeats: a show CAN have two nominees in one
 * category (e.g. two "Best Featured Actor in a Musical" Tony nominees). Those are
 * exact-string repeats and MUST be kept. We only collapse when two DIFFERENT
 * source strings name one award. See feedback_awards_schema_collapses_cross_year_wins.
 */

const CEREMONY_KEYS = [
  'tony', 'dramadesk', 'outerCriticsCircle', 'dramaLeague', 'nyDramaCritics',
  'obie', 'lortel', 'oba', 'criticsCircle', 'eveningStandard', 'whatsOnStage', 'olivier',
];

// ceremonyKey -> [[matcher (RegExp on the raw string), canonicalString], ...]
// First match wins. Matchers are anchored, case-insensitive.
const CANONICAL_RULES = {
  dramadesk: [
    [/^outstanding direction of a musical$/i, 'Outstanding Director of a Musical'],
    [/^outstanding direction of a play$/i, 'Outstanding Director of a Play'],
    [/^outstanding director of musical$/i, 'Outstanding Director of a Musical'],
    [/^outstanding director of play$/i, 'Outstanding Director of a Play'],
  ],
  outerCriticsCircle: [
    [/^outstanding direction of a musical$/i, 'Outstanding Director of a Musical'],
    [/^outstanding direction of a play$/i, 'Outstanding Director of a Play'],
    [/^outstanding director of musical$/i, 'Outstanding Director of a Musical'],
    [/^outstanding director of play$/i, 'Outstanding Director of a Play'],
    [/^outstanding book of a musical \(broadway or off-broadway\)$/i, 'Outstanding Book of a Musical'],
    [/^outstanding new score \(broadway or off-broadway\)$/i, 'Outstanding New Score'],
  ],
  dramaLeague: [
    [/^distinguished performance$/i, 'Distinguished Performance Award'],
  ],
};

/** Map one raw category string to its canonical form for the given ceremony. */
function canonicalizeAwardCategory(ceremonyKey, category) {
  if (typeof category !== 'string') return category;
  const rules = CANONICAL_RULES[ceremonyKey];
  if (!rules) return category;
  for (const [pat, canon] of rules) {
    if (pat.test(category)) return canon;
  }
  return category;
}

/**
 * Canonicalize + dedupe a wins/nominatedFor array. Collapses synonym variants to
 * a single canonical entry; preserves exact-string repeats (multiple nominees).
 */
function dedupeCategoryArray(ceremonyKey, arr) {
  if (!Array.isArray(arr)) return arr;
  const out = [];
  const seenSources = new Map(); // canonical -> Set(raw source strings already emitted)
  for (const raw of arr) {
    const canon = canonicalizeAwardCategory(ceremonyKey, raw);
    const sources = seenSources.get(canon);
    if (!sources) {
      seenSources.set(canon, new Set([raw]));
      out.push(canon);
    } else if (sources.has(raw)) {
      // exact repeat of a source already emitted -> legitimate multi-nominee, keep
      out.push(canon);
    } else {
      // different source string, same canonical -> synonym variant, drop
      sources.add(raw);
    }
  }
  return out;
}

/** Canonicalize winnerNames keys (and merge name arrays that collide). */
function canonicalizeWinnerNames(ceremonyKey, winnerNames) {
  if (!winnerNames || typeof winnerNames !== 'object') return winnerNames;
  const out = {};
  for (const [cat, names] of Object.entries(winnerNames)) {
    const canon = canonicalizeAwardCategory(ceremonyKey, cat);
    if (!out[canon]) out[canon] = [];
    for (const n of (Array.isArray(names) ? names : [])) {
      if (!out[canon].includes(n)) out[canon].push(n);
    }
  }
  return out;
}

/**
 * Canonicalize every ceremony node on one show entry in place.
 * Returns true if anything changed.
 */
function canonicalizeShowAwards(showEntry) {
  if (!showEntry || typeof showEntry !== 'object') return false;
  let changed = false;
  for (const ck of CEREMONY_KEYS) {
    const node = showEntry[ck];
    if (!node || typeof node !== 'object') continue;
    for (const field of ['wins', 'nominatedFor']) {
      if (Array.isArray(node[field])) {
        const before = JSON.stringify(node[field]);
        node[field] = dedupeCategoryArray(ck, node[field]);
        if (JSON.stringify(node[field]) !== before) changed = true;
      }
    }
    if (node.winnerNames) {
      const before = JSON.stringify(node.winnerNames);
      node.winnerNames = canonicalizeWinnerNames(ck, node.winnerNames);
      if (JSON.stringify(node.winnerNames) !== before) changed = true;
    }
  }
  return changed;
}

/** Canonicalize an entire awards.shows map in place. Returns count changed. */
function canonicalizeAllShows(shows) {
  let count = 0;
  for (const entry of Object.values(shows || {})) {
    if (canonicalizeShowAwards(entry)) count++;
  }
  return count;
}

/**
 * Detector for the CI gate: find ceremony arrays containing two DISTINCT source
 * strings that canonicalize to the same award (i.e. unresolved synonym dupes).
 * Returns [] when the data is clean.
 */
function findSynonymDuplicates(shows) {
  const issues = [];
  for (const [showId, entry] of Object.entries(shows || {})) {
    for (const ck of CEREMONY_KEYS) {
      const node = entry && entry[ck];
      if (!node) continue;
      for (const field of ['wins', 'nominatedFor']) {
        const arr = node[field];
        if (!Array.isArray(arr)) continue;
        const groups = new Map(); // canonical -> Set(distinct raw sources)
        for (const cat of arr) {
          const canon = canonicalizeAwardCategory(ck, cat);
          if (!groups.has(canon)) groups.set(canon, new Set());
          groups.get(canon).add(cat);
        }
        for (const [canonical, sources] of groups) {
          if (sources.size > 1) {
            issues.push({ showId, ceremony: ck, field, canonical, variants: [...sources] });
          }
        }
      }
      // winnerNames keys must also be canonical — otherwise the arrays can look
      // clean while winnerNames carries a stale synonym key (silent over-credit).
      if (node.winnerNames && typeof node.winnerNames === 'object') {
        const keyGroups = new Map();
        for (const key of Object.keys(node.winnerNames)) {
          const canon = canonicalizeAwardCategory(ck, key);
          if (!keyGroups.has(canon)) keyGroups.set(canon, new Set());
          keyGroups.get(canon).add(key);
        }
        for (const [canonical, keys] of keyGroups) {
          if (keys.size > 1) {
            issues.push({ showId, ceremony: ck, field: 'winnerNames', canonical, variants: [...keys] });
          }
        }
      }
    }
  }
  return issues;
}

module.exports = {
  CEREMONY_KEYS,
  CANONICAL_RULES,
  canonicalizeAwardCategory,
  dedupeCategoryArray,
  canonicalizeWinnerNames,
  canonicalizeShowAwards,
  canonicalizeAllShows,
  findSynonymDuplicates,
};
