/**
 * Ranked show-name resolution for user-supplied show names (feedback form
 * "show" field, free-text mentions in feedback messages).
 *
 * Why ranked: a flat OR-chain of equality + bidirectional substring checks
 * returns the FIRST array element matching ANY condition, so shows.json order
 * decides the winner. "MISTERMAN" resolved to the show "Ma" (1971) because
 * "misterman".includes("ma") is true and Ma sits earlier in the array than
 * "Misterman (Theatre Row)" — the feedback auto-diagnosis for GH issue #393
 * loaded the wrong show and came back confidence:low. Substring checks with no
 * token boundary also matched "Rent" inside the word "currently".
 *
 * Rules encoded here:
 *  - exact (title/slug/id) beats normalized-exact beats token-sequence overlap
 *  - all comparisons run on normalized text (lowercase, "&"->"and",
 *    parentheticals stripped from titles, punctuation collapsed)
 *  - token-sequence containment only — "rent" never matches "currently",
 *    "ma" never matches "misterman"
 *  - the contained side must be >= MIN_FUZZY_LEN chars to keep tiny titles
 *    ("Ma", "Six") from swallowing longer names
 */

const MIN_FUZZY_LEN = 4;

/** Lowercase + fold diacritics so "Misérables" == "Miserables". */
function foldCase(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** foldCase, then "&"->"and", strip punctuation, collapse whitespace. */
function normalizeShowName(s) {
  return foldCase(s)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Like normalizeShowName, but first drops parenthetical qualifiers —
 * "Misterman (Theatre Row)" -> "misterman". */
function normalizeTitleCore(s) {
  return normalizeShowName(String(s || '').replace(/\([^)]*\)/g, ' '));
}

/** True when `needle`'s token sequence appears contiguously in `haystack`'s
 * token sequence. Both args must already be normalized. */
function tokenSequenceIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Resolve a user-supplied show name against shows.json entries.
 * Returns ALL shows at the best matching rank (multiple productions of the
 * same title all match), or [] when nothing matches.
 */
function resolveShowMatches(name, shows) {
  if (!name || name === 'N/A' || !Array.isArray(shows)) return [];
  const rawLower = foldCase(name).trim();
  const norm = normalizeShowName(name);
  if (!norm) return [];

  const ranked = [[], [], []];

  for (const show of shows) {
    if (!show || !show.title) continue;
    const titleLower = foldCase(show.title);

    // Rank 0: exact title / slug / id
    if (
      titleLower === rawLower ||
      show.slug === rawLower ||
      show.slug === rawLower.replace(/\s+/g, '-') ||
      show.id === rawLower
    ) {
      ranked[0].push(show);
      continue;
    }

    // Rank 1: normalized-exact, with and without parenthetical qualifiers
    const titleNorm = normalizeShowName(show.title);
    const titleCore = normalizeTitleCore(show.title);
    if (norm === titleNorm || norm === titleCore) {
      ranked[1].push(show);
      continue;
    }

    // Rank 2: token-sequence containment either direction; the contained
    // side must be >= MIN_FUZZY_LEN chars.
    if (
      (norm.length >= MIN_FUZZY_LEN &&
        (tokenSequenceIncludes(titleNorm, norm) || tokenSequenceIncludes(titleCore, norm))) ||
      (titleCore.length >= MIN_FUZZY_LEN && tokenSequenceIncludes(norm, titleCore))
    ) {
      ranked[2].push(show);
    }
  }

  for (const bucket of ranked) {
    if (bucket.length > 0) return bucket;
  }
  return [];
}

/**
 * Resolve to a single show. When several productions match at the same rank,
 * prefer currently-running shows, then Broadway over other markets, then the
 * most recent openingDate. Status first because a user reporting a problem is
 * almost always talking about a production they can see now; market second
 * because transfers open later than originals, so newest-date alone would
 * systematically route "Hamilton" to the West End transfer instead of the
 * Broadway original.
 */
const CATEGORY_RANK = { broadway: 0, 'off-broadway': 1, 'west-end': 2 };

function resolveShow(name, shows) {
  const matches = resolveShowMatches(name, shows);
  if (matches.length === 0) return null;
  const statusRank = (s) => (s.status === 'open' ? 0 : s.status === 'previews' ? 1 : 2);
  const categoryRank = (s) => CATEGORY_RANK[s.category] ?? 3;
  return [...matches].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      categoryRank(a) - categoryRank(b) ||
      String(b.openingDate || '').localeCompare(String(a.openingDate || ''))
  )[0];
}

/**
 * Find show titles mentioned in free text. Token-boundary matching on
 * normalized text so "Rent" only matches the word "rent", never "currently".
 * Returns unique original titles. Deliberate trade-off: titles whose
 * normalized core is under MIN_FUZZY_LEN ("Six", "Ma") are never extracted
 * from free text — as standalone English words they are usually not show
 * mentions ("the six reviews I read"), and the form's show field remains the
 * primary signal for them.
 */
function extractShowTitlesFromText(message, shows) {
  if (!message || !Array.isArray(shows)) return [];
  const msgNorm = normalizeShowName(message);
  const matched = new Set();
  for (const show of shows) {
    if (!show || !show.title) continue;
    const titleCore = normalizeTitleCore(show.title);
    if (titleCore.length >= MIN_FUZZY_LEN && tokenSequenceIncludes(msgNorm, titleCore)) {
      matched.add(show.title);
    }
  }
  return Array.from(matched);
}

module.exports = {
  normalizeShowName,
  normalizeTitleCore,
  tokenSequenceIncludes,
  resolveShowMatches,
  resolveShow,
  extractShowTitlesFromText,
  MIN_FUZZY_LEN,
};
