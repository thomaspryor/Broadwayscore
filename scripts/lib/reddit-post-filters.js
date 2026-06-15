/**
 * Reddit audience-buzz post/query filters.
 *
 * Why this exists: Reddit audience buzz is scraped by searching r/Broadway (and
 * market siblings) for the show TITLE. Short / common-word / famous-other-work
 * titles ("Music City", "Mercury", "Proof", "The Lost Boys") collide with
 * unrelated chatter. Two contamination vectors, both observed in production
 * (2026-06-15, music-city-off-broadway-2026 surfaced as a newsletter "Biggest
 * Mover" on an inflated audience score):
 *
 *   1. ROUNDUP / MEGATHREAD POSTS. A bare-title search matches recurring
 *      multi-show threads — "Drama Desk Awards 2025" (189 comments), "Theater
 *      Wrap 2025", "What does your theatre week look like this week?". The
 *      thread mentions the title once among dozens of shows, but the scraper
 *      harvests EVERY comment and the LLM (told to assume ambiguous "I saw it"
 *      means the target show) attributes them to the one show. This is the
 *      audience-side analogue of isRoundupArticle for critic reviews.
 *
 *   2. GENERIC-TITLE BARE-PHRASE QUERIES. The widest query `"<title>"` pulls
 *      neutral posts that merely mention the phrase ("visiting Music City next
 *      month, what should I see?"). For collision-prone titles this floods the
 *      sample with non-reactions.
 *
 * Fix: exclude roundup/megathread posts (all shows), and for generic titles
 * market-anchor the weakest queries instead of running the bare phrase. Pure
 * functions so they can be unit-tested against real titles (CLAUDE.md §15).
 */

// Recurring / multi-show thread titles. A post whose title matches any of these
// is about many shows (or none specifically), so its comments must NOT be
// attributed to whichever show happened to match the search. Anchored to
// ceremony names and recurring-thread phrasings to avoid nuking real
// show-specific posts that happen to contain a common word.
const ROUNDUP_TITLE_PATTERNS = [
  // Awards ceremonies (the threads are giant multi-show discussions)
  /\bdrama desk\b/i,
  /\bouter critics?\b/i,
  /\bobie\b/i,
  /\btony (award|nomination|winner|nominee)/i,
  /\boscar(s| award)/i,
  /\bolivier(s| award)/i,
  /\baward(s)?\s+(nomination|winner|nominee|predictions?|recap|thread|reactions?|20\d\d)/i,
  /\b(nominations?|winners?)\s+(thread|reactions?|discussion|are (in|out)|announced|predictions?)/i,
  // Year-in-review / wrap roundups
  /\b(theat(?:er|re))\s+wrap\b/i,
  /\byear in review\b/i,
  /\bbest (shows? |musicals? |plays? )?of\s+20\d\d\b/i,
  /\b20\d\d\s+(in review|wrapped|recap|round[- ]?up)\b/i,
  // Recurring discussion / recommendation threads
  /\bwhat (are|did|should) you\b.*\b(see|seeing|saw|watch)\b/i,
  /\bwhat does your\b.*\bweek look like\b/i,
  /\b(weekly|daily|monthly|weekend)\s+(discussion|thread|recommendation)/i,
  /\bmega\s?thread\b/i,
  /\bgeneral discussion\b/i,
  /\brecommendations?\s+(thread|request|megathread)\b/i,
  /\bwhat should i (see|watch)\b/i,
  /\bwhat to (see|watch)\b/i,
];

function isRoundupOrMegathread(title) {
  if (!title) return false;
  return ROUNDUP_TITLE_PATTERNS.some((re) => re.test(title));
}

// Words that don't add disambiguating signal — stripped before counting how
// many "real" words a title has.
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', '&', 'to', 'in', 'on', 'at', 'part', 'or',
]);

// Multi-word titles that are NOT single-word but still collide hard with famous
// films / common phrases. Bare-phrase searches for these pull movie/news
// chatter. Keyed by normalized title (lowercased, punctuation→space, stopwords
// kept here so callers compare against normalizeForGenericCheck output).
const KNOWN_GENERIC_TITLES = new Set([
  'music city',          // CMT reality show + Nashville nickname + roundup magnet
  'dog day afternoon',   // 1975 Al Pacino film
  'the lost boys',       // 1987 film
  'every brilliant thing',
  'fear wonder',
  'chamber magic',
  'lean to',
  'two strangers',
  'la llamada',
  'paradise club',
]);

function normalizeForGenericCheck(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWords(title) {
  return normalizeForGenericCheck(title)
    .split(' ')
    .filter((w) => w && !TITLE_STOPWORDS.has(w));
}

/**
 * Is this title collision-prone enough that bare-phrase Reddit searches pull
 * unrelated chatter? True for single-significant-word titles (Chess, Mercury,
 * Proof) and for known multi-word film/phrase collisions.
 */
function isGenericTitle(title) {
  const norm = normalizeForGenericCheck(title);
  if (!norm) return true;
  if (KNOWN_GENERIC_TITLES.has(norm)) return true;
  const words = significantWords(title);
  return words.length <= 1;
}

/**
 * Build the ordered Reddit search query list for a show.
 *
 * Strong audience queries ("just saw X", "X review") stay unanchored to
 * preserve recall. The widest queries (bare phrase + single-keyword neutral
 * fills) are the contamination vector, so:
 *   - The bare `"<title>"` query is ALWAYS market-anchored (never run bare).
 *   - For generic titles the weak `"<title>" thoughts/loved/recommend` queries
 *     are also market-anchored.
 *
 * @returns {string[]} reddit search query strings
 */
function buildAudienceSearchQueries({ cleanTitle, marketName, isWestEnd, isOpera = false, generic = false }) {
  if (isOpera) {
    // Opera anchoring is handled by the caller (Met-specific); unchanged.
    return [
      `flair:Review "${cleanTitle}" Met`,
      `"${cleanTitle}" "Metropolitan Opera" saw`,
      `"just saw ${cleanTitle}" Met`,
      `"${cleanTitle}" Met saw`,
      `"${cleanTitle}" Met review`,
      `"${cleanTitle}" Metropolitan thoughts`,
      `"${cleanTitle}" Met loved`,
      `"${cleanTitle}" Met recommend`,
      `"${cleanTitle}" "at the Met"`,
      `"${cleanTitle}" Metropolitan Opera`,
    ];
  }

  const marketPhrase = isWestEnd ? 'in the West End' : 'on Broadway';
  const anchor = (q) => `${q} "${marketName}"`;

  return [
    `flair:Review "${cleanTitle}"`,           // Review-tagged posts (highest signal)
    `"${cleanTitle}" "${marketName}" saw`,    // Market-specific
    `"just saw ${cleanTitle}"`,               // "just saw Wicked"
    `"${cleanTitle}" saw`,                    // "I saw Wicked"
    `"${cleanTitle}" review`,                 // Reviews
    generic ? anchor(`"${cleanTitle}" thoughts`) : `"${cleanTitle}" thoughts`,
    generic ? anchor(`"${cleanTitle}" loved`) : `"${cleanTitle}" loved`,
    generic ? anchor(`"${cleanTitle}" recommend`) : `"${cleanTitle}" recommend`,
    `"${cleanTitle}" "${marketPhrase}"`,      // Market-specific phrasing
    `"${cleanTitle}" "${marketName}"`,        // Market-anchored phrase (replaces bare `"<title>"`)
  ];
}

module.exports = {
  isRoundupOrMegathread,
  isGenericTitle,
  buildAudienceSearchQueries,
  normalizeForGenericCheck,
  significantWords,
  ROUNDUP_TITLE_PATTERNS,
  KNOWN_GENERIC_TITLES,
};
