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
// films / common phrases. Each entry MUST equal normalizeForGenericCheck(<the
// stored title>) exactly — it's compared with Set.has() against that output, so
// a colloquial short form (e.g. "two strangers" for the full "Two Strangers
// (Carry a Cake Across New York)") would silently never match. The test
// asserts each entry round-trips.
const KNOWN_GENERIC_TITLES = new Set([
  'music city',          // CMT reality show + Nashville nickname + roundup magnet
  'dog day afternoon',   // 1975 Al Pacino film
  'the lost boys',       // 1987 film
  'every brilliant thing',
  'fear wonder',         // normalized "Fear & Wonder"
  'chamber magic',
  'lean to',             // normalized "Lean-To"
  'la llamada',
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
 * The bare `"<title>"` neutral-fill query was the contamination vector — it
 * pulled any post that merely mentions the phrase. It is replaced by a
 * market-anchored `"<title>" "<market>"` query for EVERY show (the
 * Broadway-qualified search the pipeline always intended for collision-prone
 * titles, applied universally because it's strictly safer). The other queries
 * (flair:Review, "just saw X", "X saw", "X review", "X thoughts/loved/
 * recommend") stay unanchored to preserve recall — including for distinctive
 * single-word shows (Hadestown, Wicked) that isGenericTitle flags but whose
 * real audience posts ("Hadestown destroyed me") omit a market word.
 *
 * @returns {string[]} reddit search query strings
 */
function buildAudienceSearchQueries({ cleanTitle, marketName, isWestEnd, isOpera = false }) {
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

  return [
    `flair:Review "${cleanTitle}"`,           // Review-tagged posts (highest signal)
    `"${cleanTitle}" "${marketName}" saw`,    // Market-specific
    `"just saw ${cleanTitle}"`,               // "just saw Wicked"
    `"${cleanTitle}" saw`,                    // "I saw Wicked"
    `"${cleanTitle}" review`,                 // Reviews
    `"${cleanTitle}" thoughts`,               // Discussion
    `"${cleanTitle}" loved`,                  // Positive reactions
    `"${cleanTitle}" recommend`,              // Recommendations
    `"${cleanTitle}" "${marketPhrase}"`,      // Market-specific phrasing
    `"${cleanTitle}" "${marketName}"`,        // Market-anchored phrase (replaces bare `"<title>"`)
  ];
}

// Date the generic-title contamination fix shipped (commit 8e8c1c4316):
// market-anchored queries + isRoundupOrMegathread post filter + per-comment LLM
// relevance classification. Reddit records last scraped BEFORE this were built by
// the old "assume any 'I saw it' is the target show" heuristic, so on collision-
// prone titles they can carry megathread/off-topic sentiment. Post-fix scrapes are
// clean. Used to measure the remaining pre-fix backlog (drained by the scraper's
// --refresh-stale mode) — NOT to auto-suppress, since stored aggregates cannot
// distinguish contamination from genuine platform bias (giant-2026 was 73%
// contaminated yet only 0.79x volume and 6pts low — invisible to any threshold).
const REDDIT_CONTAMINATION_FIX_DATE = '2026-06-15';

/**
 * Was this Reddit record harvested by the pre-fix (contamination-prone) scraper?
 * True when reddit exists, isn't already suppressed, and its lastUpdated predates
 * the fix (or is missing — undated records predate the lastUpdated field).
 * @param {object|null|undefined} reddit  audience-buzz.json sources.reddit
 * @param {string} [fixDate=REDDIT_CONTAMINATION_FIX_DATE]  ISO date boundary
 */
function isPreFixReddit(reddit, fixDate = REDDIT_CONTAMINATION_FIX_DATE) {
  if (!reddit || reddit.suppressed) return false;
  if (!reddit.lastUpdated) return true;
  return new Date(reddit.lastUpdated) < new Date(fixDate);
}

/**
 * Should scrape-reddit-sentiment.js --refresh-stale re-scrape this show?
 * True when the show is in the Reddit-scoring window (open/previews, or closed
 * within the 3yr eligibility window) AND its Reddit is stale or never
 * scraped/attempted. Honors a `redditLastAttempted` marker so a show that
 * yields no Reddit data isn't re-selected on every run (the stuck-backlog trap:
 * the oldest-first drain would otherwise churn no-signal shows forever and never
 * reach the genuinely stale backlog behind them).
 * @param {object} show                 shows.json entry ({status, closingDate})
 * @param {object|undefined} buzzRecord audience-buzz.json shows[id] ({sources, redditLastAttempted})
 * @param {{staleBefore: Date, closedWindowCutoff: Date}} opts
 */
function isRefreshStaleCandidate(show, buzzRecord, { staleBefore, closedWindowCutoff }) {
  if (!show) return false;
  const inWindow = show.status === 'open' || show.status === 'previews'
    || (show.status === 'closed' && show.closingDate && new Date(show.closingDate) >= closedWindowCutoff);
  if (!inWindow) return false;
  const rec = buzzRecord || {};
  const reddit = rec.sources && rec.sources.reddit;
  const lastTouch = (reddit && reddit.lastUpdated) || rec.redditLastAttempted;
  if (!lastTouch) return true;                 // never scraped/attempted → refresh
  return new Date(lastTouch) < staleBefore;    // stale → refresh
}

/** Sort key for --refresh-stale (oldest touch first; never-touched = 0/oldest). */
function refreshStaleSortKey(buzzRecord) {
  const rec = buzzRecord || {};
  const reddit = rec.sources && rec.sources.reddit;
  const t = (reddit && reddit.lastUpdated) || rec.redditLastAttempted;
  return t ? new Date(t).getTime() : 0;
}

module.exports = {
  isRoundupOrMegathread,
  isGenericTitle,
  buildAudienceSearchQueries,
  normalizeForGenericCheck,
  significantWords,
  isPreFixReddit,
  isRefreshStaleCandidate,
  refreshStaleSortKey,
  REDDIT_CONTAMINATION_FIX_DATE,
  ROUNDUP_TITLE_PATTERNS,
  KNOWN_GENERIC_TITLES,
};
