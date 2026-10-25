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

const { maskLongerTitles } = require('./title-containment');

const MIN_FUZZY_LEN = 4;

/** Lowercase + fold diacritics so "Misérables" == "Miserables". */
function foldCase(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** foldCase, then "&"/"'n'"->"and", strip punctuation, collapse whitespace.
 * "'n'" matters for "The Heart of Rock 'n' Roll" vs shows.json's "The Heart
 * of Rock and Roll" (BRO-4953: the diagnosis never loaded that show). */
function normalizeShowName(s) {
  return foldCase(s)
    .replace(/&/g, ' and ')
    .replace(/['’‘]n['’‘]/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(^| )n(?= |$)/g, '$1and')
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
/** Rank-1/rank-2 condition as one predicate: normalized-exact OR token-sequence
 * containment in either direction. Used by the main ranking loop. */
function fuzzyTitleMatch(norm, titleNorm, titleCore) {
  if (norm === titleNorm || norm === titleCore) return true;
  return (
    (norm.length >= MIN_FUZZY_LEN &&
      (tokenSequenceIncludes(titleNorm, norm) || tokenSequenceIncludes(titleCore, norm))) ||
    (titleCore.length >= MIN_FUZZY_LEN && tokenSequenceIncludes(norm, titleCore))
  );
}

/** Narrower than fuzzyTitleMatch: true only when the input is the title or
 * LESS (a short/partial form contained in the title) — never when the input
 * is the title PLUS extra tokens. Used for the slug-sibling expansion below:
 * a short form like "book of mormon" is genuinely ambiguous between
 * same-titled siblings, but a full slug like "the-book-of-mormon-west-end"
 * already IS the user's disambiguation (the title plus "west end"), so it
 * must not be treated as ambiguous just because it contains the title. */
function inputIsTitleOrShorter(norm, titleNorm, titleCore) {
  if (norm === titleNorm || norm === titleCore) return true;
  return (
    norm.length >= MIN_FUZZY_LEN &&
    (tokenSequenceIncludes(titleNorm, norm) || tokenSequenceIncludes(titleCore, norm))
  );
}

function resolveShowMatches(name, shows) {
  if (!name || name === 'N/A' || !Array.isArray(shows)) return [];
  const rawLower = foldCase(name).trim();
  const norm = normalizeShowName(name);
  if (!norm) return [];

  const ranked = [[], [], []];
  // Normalized titles of shows that matched rank 0 via an exact match
  // (title text OR slug/id) rather than fuzzy/normalized text. An exact
  // match is specific to ONE show's exact representation, so unlike a fuzzy
  // match it can't naturally pull in same-titled siblings whose title
  // differs by punctuation alone — handled separately below. Both the
  // title-exact and slug-exact branches feed this set: typing a sibling's
  // exact punctuated title (e.g. "Hello, Dolly!") is just as capable of
  // hiding a punctuation-variant sibling ("Hello Dolly") as typing its bare
  // slug is — the earlier version of this fix only expanded from the slug
  // branch, so the exact-title branch still reproduced the #905 shape for
  // this one input form. Grouped on normalizeTitleCore (strips
  // punctuation/parentheticals), not raw case-folded text, so siblings like
  // "Hello, Dolly!" vs "Hello Dolly" still group as the same title.
  const exactMatchedTitles = new Set();

  for (const show of shows) {
    if (!show || !show.title) continue;
    const titleLower = foldCase(show.title);

    // Rank 0: exact title
    if (titleLower === rawLower) {
      ranked[0].push(show);
      exactMatchedTitles.add(normalizeTitleCore(show.title));
      continue;
    }
    // Rank 0: exact slug / id
    if (show.slug === rawLower || show.slug === rawLower.replace(/\s+/g, '-') || show.id === rawLower) {
      ranked[0].push(show);
      exactMatchedTitles.add(normalizeTitleCore(show.title));
      continue;
    }

    // Rank 1/2: normalized-exact or token-sequence containment
    const titleNorm = normalizeShowName(show.title);
    const titleCore = normalizeTitleCore(show.title);
    if (norm === titleNorm || norm === titleCore) {
      ranked[1].push(show);
    } else if (fuzzyTitleMatch(norm, titleNorm, titleCore)) {
      ranked[2].push(show);
    }
  }

  // An exact title/slug/id match must not hide same-titled siblings that
  // would otherwise tie with it at rank 1/2 for this same input (#905:
  // "book of mormon" exact-matched book-of-mormon-2011's bare slug and
  // returned only that show, even though the West End and tour productions
  // share its title and would tie at rank 2 — "The Book of Mormon" surfaced
  // all three because that input matches all three on title text, not slug).
  if (exactMatchedTitles.size > 0) {
    for (const show of shows) {
      if (!show || !show.title || ranked[0].includes(show)) continue;
      if (!exactMatchedTitles.has(normalizeTitleCore(show.title))) continue;
      const titleNorm = normalizeShowName(show.title);
      const titleCore = normalizeTitleCore(show.title);
      if (inputIsTitleOrShorter(norm, titleNorm, titleCore)) ranked[0].push(show);
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
  // Drop a title whose every mention sits inside a longer matched title:
  // "The Heart of Rock and Roll" also contains the play "Rock 'n' Roll"
  // (BRO-4953). A standalone mention elsewhere keeps it.
  const cores = new Map(Array.from(matched, t => [t, normalizeTitleCore(t)]));
  return Array.from(matched).filter((title) => {
    const core = cores.get(title);
    const longer = Array.from(cores.values()).filter(c => c !== core && c.length > core.length && tokenSequenceIncludes(c, core));
    if (longer.length === 0) return true;
    return tokenSequenceIncludes(maskLongerTitles(msgNorm, core, longer, normalizeShowName), core);
  });
}

/**
 * True when `name` matches more than one distinct show at the best rank —
 * i.e. resolveShow() had to pick a winner instead of there being one obvious
 * answer. Callers that silently take resolveShow()'s pick (a single-match
 * assumption) can use this to flag the case instead: feedback #905 reported
 * "Book of mormon" scored wrong, resolveShow() defaulted to the Broadway 2011
 * production (categoryRank tie-break), and the diagnosis never saw that the
 * West End 2024 and tour productions also matched — one of which was the one
 * the reader actually meant.
 */
function isAmbiguousMatch(name, shows) {
  return resolveShowMatches(name, shows).length > 1;
}

/**
 * Human-readable labels for an ambiguous match set — shared by every place
 * that tells the owner "this title matched N shows" (content-request-routing.js,
 * verify-feedback-requests-live.js). Category is appended only when the
 * candidates span more than one, so a same-market tie stays plain. Codex
 * /ship-check review of BRO-4659's title-not-ID fix found two gaps in that
 * per-file duplicated logic this closes:
 *  - a null/undefined category rendered the literal string "(undefined)"
 *  - two same-titled candidates in the SAME category (e.g. two Broadway
 *    revivals of "Cabaret") still collided after the category suffix, since
 *    the suffix only ever disambiguates ACROSS categories — opening year
 *    breaks the remaining tie.
 */
function labelShowCandidates(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  const spansCategories = matches.some((m) => m && m.category !== matches[0].category);
  const base = matches.map((m) => {
    if (!m) return 'an unknown show';
    const cat = spansCategories && m.category ? ` (${m.category})` : '';
    return `${m.title || 'an untitled show'}${cat}`;
  });
  const counts = new Map();
  for (const label of base) counts.set(label, (counts.get(label) || 0) + 1);
  if (![...counts.values()].some((c) => c > 1)) return base;
  return matches.map((m, i) => {
    if (!m) return base[i];
    const year = m.openingDate ? String(m.openingDate).slice(0, 4) : null;
    return year ? `${base[i]}, opened ${year}` : `${base[i]} (${m.id})`;
  });
}

module.exports = {
  normalizeShowName,
  normalizeTitleCore,
  tokenSequenceIncludes,
  resolveShowMatches,
  resolveShow,
  isAmbiguousMatch,
  extractShowTitlesFromText,
  labelShowCandidates,
  MIN_FUZZY_LEN,
};
