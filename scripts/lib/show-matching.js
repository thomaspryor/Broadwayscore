#!/usr/bin/env node
/**
 * Shared Show Title → shows.json Matching Utility
 *
 * Used by aggregator scrapers (Playbill Verdict, NYC Theatre, NYSR)
 * to match external show titles to our tracked shows.
 *
 * Matching strategy (in order):
 * 1. Exact title match (case-insensitive)
 * 2. Known aliases (comprehensive map)
 * 3. Slug match (title → slug transformation)
 * 4. Normalized match (strip articles, "The Musical", year suffixes)
 * 5. Partial containment (title contains or is contained by show title)
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./venue-classification');

// ---------------------------------------------------------------------------
// Known Aliases: External show titles → slugs in shows.json
// ---------------------------------------------------------------------------
const KNOWN_ALIASES = {
  // Harry Potter variations
  'harry potter and the cursed child': 'harry-potter',
  'harry potter': 'harry-potter',
  'cursed child': 'harry-potter',

  // Lion King variations
  'the lion king': 'the-lion-king',
  'lion king': 'the-lion-king',

  // Beautiful Noise variations
  'a beautiful noise': 'a-beautiful-noise-2022',
  'beautiful noise': 'a-beautiful-noise-2022',
  'a beautiful noise: the neil diamond musical': 'a-beautiful-noise-2022',
  'a beautiful noise, the neil diamond musical': 'a-beautiful-noise-2022',

  // Book of Mormon variations
  'the book of mormon': 'book-of-mormon',
  'book of mormon': 'book-of-mormon',

  // MJ variations
  'mj': 'mj',
  'mj the musical': 'mj',
  'mj: the musical': 'mj',

  // SIX variations
  'six': 'six',
  'six the musical': 'six',
  'six: the musical': 'six',

  // Chicago variations
  'chicago': 'chicago',
  'chicago the musical': 'chicago',
  'chicago: the musical': 'chicago',

  // Core hits
  'hamilton': 'hamilton',
  'hamilton: an american musical': 'hamilton',
  'wicked': 'wicked',
  'wicked the musical': 'wicked',
  'aladdin': 'aladdin',
  "disney's aladdin": 'aladdin',
  'disney aladdin': 'aladdin',

  // Moulin Rouge variations
  'moulin rouge': 'moulin-rouge',
  'moulin rouge!': 'moulin-rouge',
  'moulin rouge! the musical': 'moulin-rouge',
  'moulin rouge the musical': 'moulin-rouge',
  'moulin rouge! the musical!': 'moulin-rouge',

  'hadestown': 'hadestown',

  // The Outsiders
  'the outsiders': 'the-outsiders',
  'outsiders': 'the-outsiders',
  'the outsiders musical': 'the-outsiders',

  // Great Gatsby
  'the great gatsby': 'the-great-gatsby',
  'great gatsby': 'the-great-gatsby',
  'gatsby': 'the-great-gatsby',

  // Death Becomes Her variations
  'death becomes her': 'death-becomes-her',
  'death becomes her: the musical': 'death-becomes-her',

  // Stranger Things variations
  'stranger things': 'stranger-things',
  'stranger things: the first shadow': 'stranger-things',
  'stranger things the first shadow': 'stranger-things',

  // Other current shows
  'buena vista social club': 'buena-vista-social-club',
  'operation mincemeat': 'operation-mincemeat',
  'just in time': 'just-in-time',

  // Two Strangers variations
  'two strangers': 'two-strangers',
  'two strangers (carry a cake across new york)': 'two-strangers',
  'two strangers carry a cake': 'two-strangers',

  'maybe happy ending': 'maybe-happy-ending',

  // & Juliet variations
  'and juliet': 'and-juliet',
  '& juliet': 'and-juliet',
  '&juliet': 'and-juliet',

  // Romeo and Juliet variations (& vs "and")
  'romeo & juliet': 'romeo-and-juliet',
  'romeo and juliet': 'romeo-and-juliet',

  // Oh Mary variations
  'oh, mary!': 'oh-mary',
  'oh mary': 'oh-mary',
  'oh mary!': 'oh-mary',

  'stereophonic': 'stereophonic',
  'the roommate': 'the-roommate',
  'roommate': 'the-roommate',
  'our town': 'our-town',

  // Notebook variations
  'the notebook': 'the-notebook',
  'notebook': 'the-notebook',
  'the notebook musical': 'the-notebook',

  // Back to the Future variations
  'back to the future': 'back-to-the-future',
  'back to the future: the musical': 'back-to-the-future',

  // Boop variations
  'boop! the musical': 'boop',
  'boop': 'boop',
  'boop the musical': 'boop',
  'boop!': 'boop',
  'betty boop': 'boop',

  // Water for Elephants
  'water for elephants': 'water-for-elephants',

  'suffs': 'suffs',

  // Hell's Kitchen variations
  "hell's kitchen": 'hells-kitchen',
  'hells kitchen': 'hells-kitchen',
  "hell's kitchen musical": 'hells-kitchen',

  // Cabaret variations (base slug — date-aware matching resolves production)
  'cabaret': 'cabaret',
  'cabaret at the kit kat club': 'cabaret-2024',

  // Queen of Versailles variations
  'queen of versailles': 'queen-of-versailles',
  'the queen of versailles': 'queen-of-versailles',

  'ragtime': 'ragtime',
  'chess': 'chess',
  'chess the musical': 'chess',
  'liberation': 'liberation',

  // All Out
  'all out': 'all-out',
  'all out: comedy about ambition': 'all-out',

  // Mamma Mia variations
  'mamma mia': 'mamma-mia',
  'mamma mia!': 'mamma-mia',

  'bug': 'bug',
  'marjorie prime': 'marjorie-prime',
  'oedipus': 'oedipus',
  'swept away': 'swept-away',

  // Sunset Boulevard variations
  'sunset boulevard': 'sunset-blvd-2024',
  'sunset blvd.': 'sunset-blvd-2024',
  'sunset blvd': 'sunset-blvd-2024',

  // Hills of California
  'the hills of california': 'hills-of-california',
  'hills of california': 'hills-of-california',

  'left on tenth': 'left-on-tenth',
  'tammy faye': 'tammy-faye',
  'yellowface': 'yellowface',
  'eureka day': 'eureka-day',

  // Gypsy variations (base slug — date-aware matching resolves production)
  'gypsy': 'gypsy',
  'gypsy revival': 'gypsy-2024',

  // Once Upon a Mattress
  'once upon a mattress': 'once-upon-a-mattress-2024',

  'real friends of claridge county': 'real-friends-of-claridge-county',
  'every brilliant thing': 'every-brilliant-thing',
  'death of a salesman': 'death-of-a-salesman',
  'beaches': 'beaches',
  'the balusters': 'the-balusters',
  'becky shaw': 'becky-shaw',

  // CATS variations
  // IMPORTANT: Do NOT add a bare 'cats' alias here. The original CATS (1982-2000)
  // has cumulative grosses data that would be misattributed to the 2024 revival
  // "CATS: The Jellicle Ball" if the bare alias routes there.
  'cats the jellicle ball': 'cats-the-jellicle-ball',
  'cats: the jellicle ball': 'cats-the-jellicle-ball',

  'dog day afternoon': 'dog-day-afternoon',
  'fallen angels': 'fallen-angels',
  'the fear of 13': 'the-fear-of-13',
  'fear of 13': 'the-fear-of-13',
  'giant': 'giant',
  "joe turner's come and gone": 'joe-turners-come-and-gone',
  'joe turner': 'joe-turners-come-and-gone',
  'the lost boys': 'the-lost-boys',
  'lost boys': 'the-lost-boys',
  'proof': 'proof',
  'the rocky horror show': 'the-rocky-horror-show',
  'rocky horror': 'the-rocky-horror-show',
  'schmigadoon': 'schmigadoon',
  'schmigadoon!': 'schmigadoon',
  'titanique': 'titanique',
  'real women have curves': 'real-women-have-curves',
  'redwood': 'redwood',
  'days of wine and roses': 'days-of-wine-and-roses',
  'harmony': 'harmony',
  'here lies love': 'here-lies-love',
  'how to dance in ohio': 'how-to-dance-in-ohio',
  'illinoise': 'illinoise',
  'lempicka': 'lempicka',
  'once upon a one more time': 'once-upon-a-one-more-time',
  'the heart of rock and roll': 'heart-of-rock-and-roll',
  'heart of rock and roll': 'heart-of-rock-and-roll',
  'gutenberg': 'gutenberg',
  'gutenberg! the musical!': 'gutenberg',
  'merrily we roll along': 'merrily-we-roll-along',
  'merrily': 'merrily-we-roll-along',
  'spamalot': 'spamalot',
  "the who's tommy": 'the-whos-tommy',
  'tommy': 'the-whos-tommy',
  'the wiz': 'the-wiz',
  'grey house': 'grey-house',
  'i need that': 'i-need-that',
  "jaja's african hair braiding": 'jajas-african-hair-braiding',
  'just for us': 'just-for-us',
  'mary jane': 'mary-jane',
  'mother play': 'mother-play',
  'patriots': 'patriots',
  'prayer for the french republic': 'prayer-for-the-french-republic',
  'the cottage': 'the-cottage',
  'the shark is broken': 'the-shark-is-broken',
  'an enemy of the people': 'an-enemy-of-the-people',
  'enemy of the people': 'an-enemy-of-the-people',
  'appropriate': 'appropriate',
  'doubt': 'doubt',
  'doubt: a parable': 'doubt',
  'purlie victorious': 'purlie-victorious',
  'uncle vanya': 'uncle-vanya',

  // Queen Versailles alternative slug
  'queen versailles': 'queen-versailles-2025',

  // Tina Turner Musical variations
  'tina': 'tina',
  'tina: the tina turner musical': 'tina',
  'tina the tina turner musical': 'tina',
  'tina – the tina turner musical': 'tina',

  // Beautiful/Carole King
  'beautiful': 'beautiful-the-carole-king-musical',
  'beautiful: the carole king musical': 'beautiful-the-carole-king-musical',
  'beautiful the carole king musical': 'beautiful-the-carole-king-musical',

  // Motown
  'motown': 'motown-the-musical',
  'motown the musical': 'motown-the-musical',

  // Cinderella (Rodgers + Hammerstein)
  'cinderella': 'rodgers-hammersteins-cinderella',
  "rodgers + hammerstein's cinderella": 'rodgers-hammersteins-cinderella',
  "rodgers and hammerstein's cinderella": 'rodgers-hammersteins-cinderella',

  // Young Frankenstein
  'young frankenstein': 'young-frankenstein',
  'young frankenstein the musical': 'young-frankenstein',

  // Fela!
  'fela': 'fela',
  'fela!': 'fela',

  // Shuffle Along
  'shuffle along': 'shuffle-along-or-the-making-of-the-musical-sensation-of-1921-and-all-that-followed',

  // The Motherfucker with the Hat
  'the motherfucker with the hat': 'the-motherfucker-with-the-hat',
  'the motherf**ker with the hat': 'the-motherfucker-with-the-hat',

  // Bengal Tiger
  'bengal tiger at the baghdad zoo': 'bengal-tiger-at-the-baghdad-zoo',

  // Norman Conquests (all 3 parts share the base)
  'the norman conquests': 'the-norman-conquests-table-manners',

  // Coast of Utopia
  'the coast of utopia': 'the-coast-of-utopia-part-2-shipwreck',

  // Who's Afraid of Virginia Woolf
  "who's afraid of virginia woolf": 'whos-afraid-of-virginia-woolf',
  "who's afraid of virginia woolf?": 'whos-afraid-of-virginia-woolf',

  // Sunday in the Park
  'sunday in the park with george': 'sunday-in-the-park-with-george',

  // Cry-Baby
  'cry-baby': 'crybaby',
  'cry baby': 'crybaby',

  // Les Liaisons Dangereuses
  'les liaisons dangereuses': 'les-liaisons-dangereuses',

  // Cat on a Hot Tin Roof
  'cat on a hot tin roof': 'cat-on-a-hot-tin-roof',

  // Glengarry Glen Ross
  'glengarry glen ross': 'glengarry-glen-ross',

  // A View from the Bridge
  'a view from the bridge': 'a-view-from-the-bridge',

  // Present Laughter
  'present laughter': 'present-laughter',

  // The Glass Menagerie
  'the glass menagerie': 'the-glass-menagerie',
  'glass menagerie': 'the-glass-menagerie',

  // Waiting for Godot
  'waiting for godot': 'waiting-for-godot',

  // Les Misérables
  'les miserables': 'les-miserables',
  'les misérables': 'les-miserables',

  // The Color Purple
  'the color purple': 'the-color-purple',
  'color purple': 'the-color-purple',

  // Sweeney Todd (base slug)
  'sweeney todd': 'sweeney-todd',
  'sweeney todd: the demon barber of fleet street': 'sweeney-todd',

  // Company (base slug)
  'company': 'company',

  // The Best Little Whorehouse in Texas
  'the best little whorehouse in texas': 'the-best-little-whorehouse-in-texas',

  // Angels in America
  'angels in america': 'angels-in-america-millennium-approaches',
  'angels in america: millennium approaches': 'angels-in-america-millennium-approaches',
  'angels in america: perestroika': 'angels-in-america-perestroika',
};

// ---------------------------------------------------------------------------
// Common title prefixes to strip from aggregator articles
// ---------------------------------------------------------------------------
const TITLE_STRIP_PATTERNS = [
  /^review:\s*/i,
  /^reviews?:\s*/i,
  /^what are the reviews for\s*/i,
  /^what the critics are saying about\s*/i,
  /^critics weigh in on\s*/i,
  /^the verdict:\s*/i,
  /^broadway review:\s*/i,
  /^theater review:\s*/i,
  /^theatre review:\s*/i,
  /^the reviews are in for\s*/i,
  /^reviews are in for\s*/i,
  /^critics react to\s*/i,
  /[''\u2018\u2019]/g,  // smart quotes
];

/**
 * Clean an external title by stripping common prefixes and suffixes.
 */
function cleanExternalTitle(title) {
  if (!title) return '';
  let cleaned = title.trim();

  // Strip common review-article prefixes
  for (const pattern of TITLE_STRIP_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Strip trailing " on Broadway", " (Broadway)", " - Broadway"
  cleaned = cleaned
    .replace(/\s+on\s+broadway\s*$/i, '')
    .replace(/\s*\(broadway\)\s*$/i, '')
    .replace(/\s*[-–—]\s*broadway\s*$/i, '')
    .replace(/\s*[-–—]\s*review\s*$/i, '')
    .replace(/\s*\(review\)\s*$/i, '')
    .trim();

  return cleaned;
}

/**
 * Normalize a title for fuzzy comparison.
 * Strips articles, "The Musical", punctuation, etc.
 */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/:\s*(the\s*)?musical$/i, '')
    .replace(/\s+the\s+musical$/i, '')
    .replace(/\s+on\s+broadway$/i, '')
    .replace(/[!?.,'"''\u2018\u2019\u201C\u201D:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a title to a slug.
 */
function titleToSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

/**
 * Build slug variants for London audience scrapers (SeatPlan, LBO).
 * Strips venue suffixes, "the-", "-the-musical", subtitles, etc.
 * @param {string} title - Show title
 * @param {function} [slugFn] - Custom slug function (default: titleToSlug)
 * @returns {string[]} Array of unique slug variants
 */
function buildLondonSlugVariants(title, slugFn) {
  const toSlug = slugFn || titleToSlug;
  // Strip venue suffixes like " - Globe", " - Southbank Centre"
  const stripped = title.replace(/\s*[-\u2013\u2014]\s*(Globe|Southbank Centre)$/i, '');
  const baseSlug = toSlug(title);
  const strippedSlug = toSlug(stripped);
  const variants = [baseSlug];
  if (strippedSlug !== baseSlug) variants.push(strippedSlug);
  // Drop leading "the-" on all variants
  for (const slug of [...variants]) {
    if (slug.startsWith('the-')) variants.push(slug.replace(/^the-/, ''));
  }
  // Drop trailing "-the-musical" on all variants
  for (const slug of [...variants]) {
    if (slug.endsWith('-the-musical')) variants.push(slug.replace(/-the-musical$/, ''));
  }
  // Drop trailing "-musical"
  if (baseSlug.endsWith('-musical') && !baseSlug.endsWith('-the-musical')) {
    variants.push(baseSlug.replace(/-(?:a-)?musical$/, ''));
  }
  // Drop internal "-the-" (e.g., "paddington-the-musical" → "paddington-musical")
  for (const slug of [...variants]) {
    const withoutThe = slug.replace(/-the-/g, '-');
    if (withoutThe !== slug) variants.push(withoutThe);
  }
  // Drop common suffixes: "-on-stage", "-the-classic-story-on-stage", "-the-first-shadow"
  for (const suffix of ['-on-stage', '-the-classic-story-on-stage', '-the-first-shadow',
    '-a-comedy-by-florian-zeller', '-an-improvised-jane-austen-novel',
    '-the-untold-story-of-ursula-the-sea-witch', '-new-wimbledon-theatre',
    '-and-the-merry-mandem']) {
    for (const slug of [...variants]) {
      if (slug.endsWith(suffix)) variants.push(slug.replace(new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ''));
    }
  }
  // Drop subtitle after colon
  const subtitleIdx = title.indexOf(':');
  if (subtitleIdx > 0) variants.push(toSlug(title.slice(0, subtitleIdx)));
  // Drop "-both-parts"
  const bpIdx = baseSlug.indexOf('-both-parts');
  if (bpIdx > 0) variants.push(baseSlug.slice(0, bpIdx));
  // First 2-3 words for very long slugs
  const parts = baseSlug.split('-');
  if (parts.length > 5) {
    variants.push(parts.slice(0, 2).join('-'));
    variants.push(parts.slice(0, 3).join('-'));
  }
  return [...new Set(variants)];
}

/**
 * Pick the best production when multiple shows match the same title.
 * If an active date is provided, prefers the production whose run window
 * (openingDate..closingDate, with slack) actually contains that date — this
 * is strictly more precise than year-proximity and used by historical
 * backfills where the exact week being resolved is known.
 * Else if a target year is provided, picks the production with closest opening year.
 * Otherwise, picks the most recent production.
 */
function pickBestProduction(matches, targetYear, preferredMarket, prefer, activeDate) {
  if (matches.length === 1) return matches[0];

  // Market-aware filtering: if a preferred market is specified (e.g., 'broadway',
  // 'west-end', 'off-west-end', 'off-broadway'), filter to only matching productions first.
  // This prevents cross-market contamination when the same title exists in multiple
  // markets (e.g., hamilton-2015 vs hamilton-west-end-2021).
  if (preferredMarket && matches.length > 1) {
    const marketMatches = matches.filter(m => {
      const cat = (m.category || '').toLowerCase();
      if (preferredMarket === 'broadway') return !cat || cat === 'broadway';
      // For London markets, match both WE and OWE
      if (isLondonMarket(preferredMarket)) return isLondonMarket(cat);
      return cat === preferredMarket;
    });
    if (marketMatches.length > 0) {
      matches = marketMatches;
      if (matches.length === 1) return matches[0];
    }
  }

  // Active-date containment: if exactly one production's run window (with a
  // 14-day slack for previews / closing-notice weeks) actually contains the
  // date, that's a stronger signal than year proximity — it can't be fooled
  // by two productions opening in adjacent years. Falls through to the
  // year/prefer logic below if 0 or 2+ productions match the window.
  if (activeDate && matches.length > 1) {
    const SLACK_MS = 14 * 24 * 60 * 60 * 1000;
    const activeMs = new Date(activeDate).getTime();
    if (!isNaN(activeMs)) {
      const windowMatches = matches.filter(m => {
        if (!m.openingDate) return false;
        const openMs = new Date(m.openingDate).getTime();
        if (isNaN(openMs) || activeMs < openMs - SLACK_MS) return false;
        if (!m.closingDate) return true; // still open (or no recorded close) — in range
        const closeMs = new Date(m.closingDate).getTime();
        return isNaN(closeMs) || activeMs <= closeMs + SLACK_MS;
      });
      if (windowMatches.length === 1) return windowMatches[0];
    }
  }

  if (!targetYear) {
    // No date hint — use prefer option to pick the right production.
    // 'open' = currently-running production (for weekly grosses, lottery/rush)
    // 'original' = earliest opening (for cumulative all-time data)
    // 'recent' = most recent opening (default, for reviews/news)
    const strategy = prefer || 'recent';
    const ids = matches.map(m => m.id).join(', ');

    // For 'open' or 'recent' strategy: if exactly one production is currently running, pick it.
    // This prevents announced/future shows from beating a running production.
    if (strategy === 'open' || strategy === 'recent') {
      const openShows = matches.filter(m => m.status === 'open' || m.status === 'previews');
      if (openShows.length === 1) return openShows[0];
      // Fall through to year comparison if 0 or 2+ are open
    }

    // For 'recent' strategy: filter out announced shows before year comparison,
    // so a future date on an announced show can't beat a closed show with reviews.
    // Only filter if non-announced candidates remain (avoid empty set).
    let candidates = matches;
    if (strategy === 'recent') {
      const nonAnnounced = matches.filter(m => m.status !== 'announced');
      if (nonAnnounced.length > 0) candidates = nonAnnounced;
    }

    console.warn(`  ⚠️  [AMBIGUOUS MATCH] ${matches.length} productions for "${matches[0].title}" (${ids}) — no year hint, picking ${strategy}. Pass { year } to disambiguate.`);
    return candidates.reduce((best, show) => {
      const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 0;
      const bestYear = best.openingDate ? new Date(best.openingDate).getFullYear() : 0;
      if (strategy === 'original') {
        return showYear < bestYear ? show : best;
      }
      return showYear > bestYear ? show : best;
    });
  }
  // Pick closest to target year
  return matches.reduce((best, show) => {
    const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 9999;
    const bestYear = best.openingDate ? new Date(best.openingDate).getFullYear() : 9999;
    return Math.abs(showYear - targetYear) < Math.abs(bestYear - targetYear) ? show : best;
  });
}

/**
 * Match an external show title to a show in shows.json.
 * When multiple productions match (e.g., cabaret-1998, cabaret-2024),
 * disambiguates by closest opening year to options.year.
 *
 * @param {string} externalTitle - The title from the external source
 * @param {Object[]} shows - Array of show objects from shows.json
 * @param {Object} [options] - Optional settings
 * @param {number} [options.year] - Publication year for multi-production disambiguation
 * @param {string} [options.market] - Preferred market ('broadway'|'west-end'|'off-west-end'|'off-broadway') for cross-market disambiguation
 * @param {string} [options.prefer] - 'recent' (default) or 'original' — which production to pick when ambiguous with no year hint
 * @param {string|Date} [options.date] - Exact date the title is being matched for (e.g. a historical backfill week). Preferred over options.year: filters to the production whose openingDate..closingDate window actually contains this date (14-day slack), before falling back to year/prefer.
 * @returns {{ show: Object, confidence: 'high'|'medium' } | null}
 */
function matchTitleToShow(externalTitle, shows, options) {
  if (!externalTitle || !shows || shows.length === 0) return null;

  const targetYear = options?.year || null;
  const preferredMarket = options?.market || null;
  const prefer = options?.prefer || null;
  const activeDate = options?.date || null;
  const cleaned = cleanExternalTitle(externalTitle);
  // Strip diacritics (NFD decompose then drop combining marks) so accented
  // titles match their plain counterparts in shows.json and KNOWN_ALIASES.
  // Without this, "TITANÍQUE" (from BroadwayWorld) never matches the alias
  // key "titanique" and falls through to medium-confidence word matching,
  // which scrape-grosses.ts rejects for financial data. Caught 2026-04-14.
  const lowerCleaned = cleaned.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!lowerCleaned) return null;

  // Try the full title first, then try stripping subtitle after colon/dash
  // This handles "Show Title: Review Subtitle" patterns (NYSR, Playbill, etc.)
  const titleVariants = [lowerCleaned];
  if (lowerCleaned.includes(':')) {
    titleVariants.push(lowerCleaned.split(':')[0].trim());
  }
  if (lowerCleaned.includes(' – ') || lowerCleaned.includes(' — ')) {
    titleVariants.push(lowerCleaned.split(/\s+[–—]\s+/)[0].trim());
  }

  // Build slug → show lookup
  const slugToShow = {};
  for (const show of shows) {
    const slug = show.slug || show.id;
    slugToShow[slug] = show;
  }

  // Try each title variant (full title, then stripped subtitle)
  for (const variant of titleVariants) {
    // 1. Exact title match against shows.json titles (collect all for multi-production)
    // Strip diacritics from showTitle too — `variant` is already diacritic-stripped
    // (line ~616), but shows.json is inconsistent about accents across productions
    // of the same title (e.g. "Les Miserables" 1987 vs "Les Misérables" 2006/2014).
    // Without this, only the non-accented production exact-matches and short-circuits
    // before multi-production disambiguation ever runs. Found 2026-07-20: this caused
    // 195 chronologically-impossible les-miserables-1987 entries in a historical backfill.
    const exactMatches = [];
    for (const show of shows) {
      const showTitle = (show.title || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (showTitle === variant) {
        exactMatches.push(show);
      }
    }
    if (exactMatches.length > 0) {
      return { show: pickBestProduction(exactMatches, targetYear, preferredMarket, prefer, activeDate), confidence: 'high' };
    }

    // 2. Known aliases → slug → show (collect all for multi-production disambiguation)
    if (KNOWN_ALIASES[variant]) {
      const slug = KNOWN_ALIASES[variant];
      const aliasMatches = [];
      if (slugToShow[slug]) {
        aliasMatches.push(slugToShow[slug]);
      }
      // Slug prefix match (e.g., 'cabaret' matches 'cabaret-2024', 'cabaret-1998')
      for (const show of shows) {
        const showSlug = show.slug || show.id;
        if ((showSlug.startsWith(slug + '-') || showSlug === slug) && !aliasMatches.includes(show)) {
          aliasMatches.push(show);
        }
      }
      if (aliasMatches.length > 0) {
        return { show: pickBestProduction(aliasMatches, targetYear, preferredMarket, prefer, activeDate), confidence: 'high' };
      }
    }

    // 3. Direct slug match
    const directSlug = titleToSlug(variant);
    if (slugToShow[directSlug]) {
      return { show: slugToShow[directSlug], confidence: 'high' };
    }

    // 4. Normalized match: strip articles, "The Musical", year suffixes (collect all)
    const normalizedInput = normalizeTitle(variant);
    const normalizedMatches = [];
    for (const show of shows) {
      const showSlug = show.slug || show.id;
      const normalizedSlug = showSlug
        .replace(/^(the-|a-|an-)/i, '')
        .replace(/-\d{4}$/, '');  // Strip year suffix
      const normalizedSlugSpaces = normalizedSlug.replace(/-/g, ' ');

      if (normalizedInput === normalizedSlugSpaces) {
        normalizedMatches.push(show);
        continue;
      }

      // Also normalize the show title itself
      const normalizedShowTitle = normalizeTitle(show.title || '');
      if (normalizedInput === normalizedShowTitle && !normalizedMatches.includes(show)) {
        normalizedMatches.push(show);
      }
    }
    if (normalizedMatches.length > 0) {
      return { show: pickBestProduction(normalizedMatches, targetYear, preferredMarket, prefer, activeDate), confidence: 'high' };
    }
  }

  // 5. Word-based matching (lower confidence) — uses titleWordsMatch to prevent
  //    false positives from common words (e.g., "out" in "Reviews Are Out" matching "All Out")
  for (const variant of titleVariants) {
    if (variant.length > 2) {
      const wordMatches = [];
      for (const show of shows) {
        const showTitle = (show.title || '').trim();
        if (showTitle.length > 2 && titleWordsMatch(showTitle, variant)) {
          wordMatches.push(show);
        }
      }
      if (wordMatches.length > 0) {
        return { show: pickBestProduction(wordMatches, targetYear, preferredMarket, prefer, activeDate), confidence: 'medium' };
      }
    }
  }

  return null;
}

/**
 * Load shows from shows.json.
 * @returns {Object[]} Array of show objects
 */
function loadShows() {
  const showsPath = path.join(__dirname, '../../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return data.shows || data;
}

// ---------------------------------------------------------------------------
// Robust title-word matching for aggregator page validation
// Prevents wrong-show contamination from Google search results and fuzzy URL routing
// ---------------------------------------------------------------------------

const TITLE_GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'new', 'musical', 'play', 'broadway', 'show', 'revival',
  'comedy', 'drama', 'about', 'and', 'of', 'in', 'on', 'at', 'for', 'to',
  'is', 'it', 'my', 'all', 'be', 'or', 'no', 'so', 'do', 'we', 'up', 'if',
  'me', 'us', 'by', 'with', 'from', 'review', 'reviews', 'roundup', 'critics',
  'verdict', 'what', 'are', 'says', 'think', 'say', 'out', 'into', 'off',
  'opens', 'opening', 'open', 'how', 'now', 'just', 'come', 'go', 'get',
  'has', 'had', 'have', 'was', 'not', 'but', 'one', 'two', 'can', 'will',
]);

/**
 * Check if candidateText (article title, URL slug, or page body) matches a show title.
 *
 * Uses three-tier matching based on meaningful-word count:
 *   - Single-word titles: word-boundary regex (prevents "dog" matching "topdog")
 *   - Multi-word titles: ≥50% of meaningful words must appear (min 2)
 *   - Zero meaningful words after filtering: raw first-word substring fallback
 *
 * @param {string} showTitle - The show's title from shows.json
 * @param {string} candidateText - Text to check (article title, URL slug, page body)
 * @returns {boolean} Whether the candidate matches the show title
 */
/**
 * Check if a word appears as a whole word in text (not as a substring of another word).
 * Uses the same boundary character set as the single-word path (line 643 originally).
 * Prevents false matches like "man" inside "dutchman" or "dance" inside "sundance".
 */
/**
 * Normalize text for matching: strip diacritics, unify quotes/apostrophes to straight form.
 * Prevents false negatives when shows.json has "Misérables" but text has "Miserables",
 * or title has curly ' but text has straight '.
 */
function normalizeForMatching(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")             // curly single → straight
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"');             // curly double → straight
}

function matchesAsWholeWord(word, text) {
  const escaped = normalizeForMatching(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizedText = normalizeForMatching(text);
  const re = new RegExp(`(?:^|[\\s\\-/,.?!:;'""\\u2018\\u2019\\u201C\\u201D])${escaped}(?:$|[\\s\\-/,.?!:;'""\\u2018\\u2019\\u201C\\u201D])`, 'i');
  return re.test(normalizedText) || re.test(normalizedText.replace(/-/g, ' '));
}

function titleWordsMatch(showTitle, candidateText) {
  // First try the pre-colon part (e.g., "All Out" from "All Out: Comedy About Ambition")
  // Normalize: strip accents (NFD decompose + remove combining marks) and punctuation
  const normalizeWord = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const showTitleLower = showTitle.toLowerCase()
    .replace(/^the\s+/, '').replace(/\s*[:(].*$/, '').trim();
  let showSlugWords = showTitleLower.split(/[\s,]+/)
    .map(normalizeWord)
    .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));

  // If pre-colon part has no meaningful words, use the FULL title including subtitle
  // (e.g., "All Out: Comedy About Ambition" → "ambition" is the only distinctive word)
  if (showSlugWords.length === 0) {
    const fullTitleLower = showTitle.toLowerCase().replace(/^the\s+/, '').trim();
    showSlugWords = fullTitleLower.split(/[\s,:()]+/)
      .map(normalizeWord)
      .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));
  }

  // Deduplicate to prevent double-counting (e.g., "Man to Man" → ["man","man"] → ["man"])
  showSlugWords = [...new Set(showSlugWords)];

  const candidateLower = candidateText.toLowerCase();

  if (showSlugWords.length === 0) {
    // Fallback: raw first word with word-boundary check (not substring)
    const rawTitle = normalizeWord(showTitleLower.split(/[\s,]+/)[0] || '');
    return rawTitle && rawTitle.length >= 3 && matchesAsWholeWord(rawTitle, candidateLower);
  }

  if (showSlugWords.length === 1) {
    // Single-word: word-boundary match to prevent partial matches
    return matchesAsWholeWord(showSlugWords[0], candidateLower);
  }

  // Multi-word: require ≥50% of meaningful words, minimum 2
  // Use word-boundary matching for ALL words to prevent "man" matching inside "dutchman"
  const matchCount = showSlugWords.filter(w => matchesAsWholeWord(w, candidateLower)).length;
  const threshold = Math.max(2, Math.ceil(showSlugWords.length * 0.5));
  if (matchCount < threshold) return false;

  // Short-title guard: titles with <=3 meaningful words are vulnerable to containment
  // matches (e.g., "Happy Ending" matching "Maybe Happy Ending"). If all show words match
  // but the candidate has extra DISTINCTIVE words (not venue/review context), reject —
  // the candidate is likely a different, longer-titled show.
  if (showSlugWords.length <= 3 && matchCount === showSlugWords.length) {
    // Context words that commonly appear in URLs/titles alongside show names
    // but don't indicate a different show (venues, review terms, markets)
    const CONTEXT_WORDS = new Set([
      'review', 'reviews', 'theatre', 'theater', 'london', 'broadway',
      'west', 'end', 'musical', 'play', 'show', 'stage', 'tickets',
      'cast', 'opening', 'night', 'preview', 'stars', 'rating', 'score',
      'garrick', 'palace', 'lyceum', 'apollo', 'gielgud', 'savoy',
      'roundup', 'round', 'critics', 'critic', 'rated', 'best', 'worst',
      'waterloo', 'soho', 'covent', 'garden', 'piccadilly', 'drury', 'lane',
      'bridge', 'donmar', 'warehouse', 'national', 'arts', 'fortune',
      'globe', 'old', 'vic', 'young', 'duke', 'york', 'haymarket',
      'east', 'north', 'south', 'street', 'square', 'road', 'house',
    ]);
    // Use FULL title words (including subtitle) — showSlugWords may only have pre-colon part
    const fullTitleWords = showTitle.toLowerCase().split(/[\s,:()&]+/)
      .map(normalizeWord)
      .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));
    const showWordsClean = new Set(fullTitleWords);
    const candidateWords = candidateLower.split(/[\s,\-_/]+/)
      .map(normalizeWord)
      .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w) && !CONTEXT_WORDS.has(w)
        && !/^(?:19|20)\d\d$/.test(w));  // Exclude year tokens (2024, 2025, etc.)
    const extraWords = candidateWords.filter(w => !showWordsClean.has(w));
    if (extraWords.length >= 1) return false;
  }

  return true;
}

/**
 * Confidence-aware version of titleWordsMatch for page validation.
 * Returns metadata instead of boolean so callers can trigger LLM tiebreaker
 * on low-confidence matches (short titles, borderline word counts).
 *
 * Own copy of matching logic — does NOT share internals with titleWordsMatch()
 * so existing callers of the boolean version are unaffected.
 *
 * @param {string} showTitle - The show's title from shows.json
 * @param {string} candidateText - Text to check (page title, headings)
 * @returns {{ matched: boolean, confidence: number, matchCount: number, threshold: number, words: string[] }}
 */
function titleWordsMatchWithConfidence(showTitle, candidateText) {
  const showTitleLower = showTitle.toLowerCase()
    .replace(/^the\s+/, '').replace(/\s*[:(].*$/, '').trim();
  let words = showTitleLower.split(/[\s,]+/)
    .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));

  // Full-title fallback if pre-colon part has no meaningful words
  if (words.length === 0) {
    const fullTitleLower = showTitle.toLowerCase().replace(/^the\s+/, '').trim();
    words = fullTitleLower.split(/[\s,:()]+/)
      .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));
  }

  // Deduplicate to prevent double-counting (e.g., "Man to Man" → ["man","man"] → ["man"])
  words = [...new Set(words)];

  const candidateLower = candidateText.toLowerCase();

  // Zero meaningful words — very low confidence.
  // Edge case: purely numeric / short titles ("13", "9 to 5", "1776"). The
  // length≥3 fallback misses "13"/"9". For these, try a whole-word match
  // against the FULL title string (preserves spacing, e.g. "9 to 5") OR a
  // numeric-only first token. The whole-word boundary prevents false
  // positives — "13" inside "1973" wouldn't match.
  if (words.length === 0) {
    const rawFirst = showTitleLower.split(/[\s,]+/)[0];
    const fullTitle = showTitleLower.trim();
    // Try the full normalized title first (handles "9 to 5", "13", "1776")
    if (fullTitle && matchesAsWholeWord(fullTitle, candidateLower)) {
      return { matched: true, confidence: 0.4, matchCount: 1, threshold: 1, words: [fullTitle] };
    }
    // Fall back to first-token match: length≥3 OR purely numeric
    const matched = rawFirst &&
      (rawFirst.length >= 3 || /^\d+$/.test(rawFirst)) &&
      matchesAsWholeWord(rawFirst, candidateLower);
    return { matched, confidence: matched ? 0.3 : 0, matchCount: matched ? 1 : 0, threshold: 1, words: rawFirst ? [rawFirst] : [] };
  }

  // Single meaningful word — moderate confidence at best
  if (words.length === 1) {
    const matched = matchesAsWholeWord(words[0], candidateLower);
    return { matched, confidence: matched ? 0.6 : 0, matchCount: matched ? 1 : 0, threshold: 1, words };
  }

  // Multi-word: ≥50% of meaningful words, minimum 2
  // Use word-boundary matching for ALL words to prevent substring false positives
  const matchedWords = words.filter(w => matchesAsWholeWord(w, candidateLower));
  const missingWords = words.filter(w => !matchesAsWholeWord(w, candidateLower));
  const matchCount = matchedWords.length;
  const threshold = Math.max(2, Math.ceil(words.length * 0.5));
  const matched = matchCount >= threshold;
  const confidence = matched ? matchCount / words.length : 0;
  return { matched, confidence, matchCount, threshold, words, matchedWords, missingWords };
}

/**
 * Validate that an aggregator/roundup HTML page is actually about the show
 * we think it is, by comparing the show title against the page's <title> tag.
 *
 * Returns { ok, reason, pageTitle } so callers can log/skip without filing
 * reviews against the wrong show. Used by every script that reads cached
 * LBO/aggregator archives, since those archives are keyed by showId and the
 * cache itself has no integrity guarantee.
 *
 * Background: Stuart King (LBO Head Reviewer) reported on 2026-04-25 that
 * we'd attributed an Oh, Mary! excerpt to him on Magic Mike Live, plus a
 * Paddington excerpt on Teeth 'n' Smiles. Root cause was three readers
 * (scrape-london-box-office-roundups, opening-night-poller, gather-reviews)
 * trusting cached archive HTML without checking it matched the showId in
 * the file path.
 */
function validateRoundupPageTitle(html, showTitle) {
  if (!html || typeof html !== 'string') {
    return { ok: false, reason: 'no-html', pageTitle: null };
  }
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) {
    return { ok: false, reason: 'no-title-tag', pageTitle: null };
  }
  const pageTitle = m[1].trim();
  const conf = titleWordsMatchWithConfidence(showTitle, pageTitle);
  if (conf.matched) {
    return { ok: true, reason: 'matched', pageTitle, confidence: conf.confidence };
  }
  return {
    ok: false,
    reason: 'page-title-mismatch',
    pageTitle,
    matchCount: conf.matchCount,
    threshold: conf.threshold,
    showWords: conf.words,
  };
}

// ---------------------------------------------------------------------------
// Playbill-Verdict slug helpers
//
// Playbill's review-roundup article URLs encode the show title in the slug,
// but wrap it in arbitrary verb phrases:
//   /article/reviews-what-do-the-critics-think-of-beaches-on-broadway
//   /article/read-reviews-for-heather-christians-animal-wisdom
//   /article/did-the-olivier-winning-kenrex-make-a-big-splash-with-new-york-critics
// The wrapper words defeat fuzzy title matching, so the existing Pattern-3
// fallback (slug → title-case → matchTitleToShow) silently dropped every
// OB roundup with these patterns. The "Animal Wisdom" article was visible in
// the May 24, 2026 category-page cache but matchTitleToShow returned NULL.
//
// Strategy: strip known leading verb phrases, then substring-match against
// shows.json slugs (with year/market suffix variants). The longest match wins.
// This handles middle-title slugs (Kenrex, Rocky Horror, Celebrity
// Autobiography) that pure head/tail stripping can't.
// ---------------------------------------------------------------------------

const PV_HEAD_PATTERNS = [
  /^reviews-what-(do-the|did)-critics-think-of-/,
  /^reviews-(did|do)-(the-)?critics-(feel-at-home-on|find|think)-/,
  /^reviews-are-out-for-/,
  /^reviews-sound-off-on-/,
  /^read-the-reviews-for-/,
  /^read-reviews-for-/,
  /^what-(are|do|did)-(the-)?(reviews|critics)-(think-of-|for-)?/,
  /^did-the-olivier-winning-/,
  /^did-(reviewers|critics)-(find-magic-in-|think-of-|find-)?/,
  /^how-did-/,
];

const PV_TAIL_PATTERNS = [
  /-in-londons-west-end$/,
  /-on-broadway$/,
  /-off-broadway$/,
  /-at-(brooklyn-academy-of-music|met-opera|studio-seaview|linda-gross|atlantic-theater|signature(-theatre)?|new-york-theatre-workshop|classic-stage-company|second-stage|playwrights-horizons|the-public-theater|theatre-row|audible|bam)$/,
];

function _stripPvHead(slug) {
  for (const p of PV_HEAD_PATTERNS) {
    const next = slug.replace(p, '');
    if (next !== slug) return next;
  }
  return slug;
}

function _stripPvTail(slug) {
  let s = slug;
  for (const p of PV_TAIL_PATTERNS) s = s.replace(p, '');
  return s;
}

/**
 * Clean a Playbill-Verdict article slug into a plausible show-title string.
 * Used for the audit log entry; not the primary match path (substring-match
 * via matchSlugToShow is more reliable for middle-title cases).
 * @param {string} slug - raw slug like "read-reviews-for-heather-christians-animal-wisdom"
 * @returns {string} title-cased best-guess, e.g. "Animal Wisdom" or "Heather Christians Animal Wisdom"
 */
function cleanSlugTitle(slug) {
  if (!slug || typeof slug !== 'string') return '';
  let s = slug.toLowerCase().replace(/^\/?article\//, '');
  s = _stripPvHead(s);
  s = _stripPvTail(s);
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

/**
 * Classify whether a Playbill article slug looks like a Verdict review
 * roundup (as opposed to news/casting/gallery content) — a slug matches one
 * of the known review-wrapper verb phrases in PV_HEAD_PATTERNS.
 *
 * Used to filter playbill.com/sitemap.xml entries (which cover the whole
 * site, not just /category/the-verdict) down to review-roundup candidates.
 * @param {string} slug
 * @returns {boolean}
 */
function isVerdictReviewSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  const s = slug.toLowerCase().replace(/^\/?article\//, '');
  return _stripPvHead(s) !== s;
}

/**
 * Match a Playbill-Verdict article URL slug to a show in shows.json by
 * looking for the longest show slug that appears as a token-boundary substring
 * after stripping Playbill's known head verbs.
 *
 * @param {string} rawSlug - article slug like "reviews-what-do-the-critics-think-of-beaches-on-broadway"
 * @param {Object[]} shows - shows.json array
 * @returns {{ show: Object, confidence: 'high', via: 'slug-substring' } | null}
 */
// Tokens that appear in slugs but don't distinguish shows. Stripped from
// each show's "distinctive token set" before token-overlap scoring so that
// `the-balusters-on-broadway` doesn't have "broadway" as a token a slug must
// hit, and `the-rocky-horror-show` doesn't gate on the noise word "show".
const _SLUG_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'for', 'to', 'by',
  'broadway', 'off-broadway', 'west-end', 'musical', 'play', 'show',
  'revival', 'tour', 'starring', 'opens', 'review', 'reviews', 'critics',
]);

/**
 * Distinctive tokens from a show's TITLE (not its id/slug).
 *
 * Why title and not id: show IDs encode the full subtitle for uniqueness
 * (e.g. `holiday-inn-the-new-irving-berlin-musical-2016`) but slugs in
 * aggregator articles use the common title only (e.g. `HOLIDAY-INN-...`).
 * Pre-2026-05-27 the matcher used id-based tokens and rejected the
 * Holiday Inn 2016 show because [new, irving, berlin] weren't in the
 * slug — silently routing reviews to closed `holiday-1995` (single token
 * `holiday` matches everything). Discovered 2026-05-27 after manual move.
 *
 * Strategy:
 *  - Source from show.title.
 *  - Strip after first comma or colon (subtitle separators) — keeps
 *    "Holiday Inn" from "Holiday Inn, The New Irving Berlin Musical",
 *    "Heated Rivalry" from "Heated Rivalry: The Unauthorized Musical
 *    Parody". Titles without these separators (e.g. "Cabaret at the Kit
 *    Kat Club") are used in full.
 *  - Normalize apostrophes/punctuation, lowercase, dedupe.
 *  - Filter out stopwords + tokens <3 chars.
 */
function _tokenizeTitleText(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3 && !_SLUG_STOPWORDS.has(t));
}

function _showDistinctiveTokens(show) {
  const titleRaw = show.title || show.slug || show.id || '';
  if (!titleRaw) return [];
  // Strip subtitle (after first comma or colon). "Heated Rivalry: The
  // Unauthorized Musical Parody" → "Heated Rivalry". "Holiday Inn, The
  // New Irving Berlin Musical" → "Holiday Inn". Aggregator slugs almost
  // always use the primary title.
  const primary = String(titleRaw).split(/[,:]/)[0];
  let tokens = [...new Set(_tokenizeTitleText(primary))];
  // Fall back to FULL title when the comma/colon split was too aggressive
  // — e.g. "Well, I'll Let You Go" pre-comma yields [well] which is too
  // weak. Use the full title's tokens in that case.
  if (tokens.length === 1 && tokens[0].length < 5) {
    const full = [...new Set(_tokenizeTitleText(String(titleRaw)))];
    if (full.length > tokens.length) tokens = full;
  }
  return tokens;
}

function _tokenAppearsInSlug(token, cleanedSlug) {
  let idx = -1;
  while ((idx = cleanedSlug.indexOf(token, idx + 1)) !== -1) {
    const startOk = idx === 0 || cleanedSlug[idx - 1] === '-';
    const endOk = idx + token.length === cleanedSlug.length || cleanedSlug[idx + token.length] === '-';
    if (startOk && endOk) return true;
  }
  return false;
}

/**
 * Match an article URL slug to a show in shows.json by counting how many of
 * the show's distinctive title tokens appear (as token-boundary substrings)
 * in the cleaned slug. The cleanedSlug has all aggregator-specific verb
 * wrappers + market suffixes ALREADY stripped — this function is
 * source-agnostic. Used by matchSlugToShow (PV) and matchBwwRoundupSlug (BWW).
 *
 * Why token-set instead of longest-substring (the previous strategy):
 *   For slug `bedlams-4-person-version-of-shakespeares-othello` and the open
 *   show `bedlams-othello-off-broadway-2026`, the show's distinctive tokens
 *   are [bedlams, othello] — both appear in the slug, but NOT adjacent, so
 *   no substring of the show slug appears verbatim. The longest-substring
 *   match against `othello-2025` (closed) wins on length but loses on
 *   token-set count (1 vs 2). The Bedlam's Othello 2026 reviews shipped to
 *   the wrong show on 2026-05-27 because of this. Token-set scoring also
 *   incidentally handles Schmigadoon-on-Kennedy-Center, Hamlet-at-BAM, and
 *   other multi-word show titles where intervening venue tokens previously
 *   prevented the show's full slug from appearing as a single substring.
 */
/**
 * Absolute year distance between a show's opening and a target article year.
 * Returns Infinity when the article year is unknown or the show has no
 * parseable openingDate, so a dateless production never registers as
 * "in window" and never wins the date-proximity axis. Mirrors
 * pickBestProduction's Math.abs nearest-year logic (line ~560).
 */
function _yearGap(show, articleYear) {
  if (!articleYear) return Infinity;
  const y = parseInt((show.openingDate || '').slice(0, 4), 10);
  if (!y) return Infinity;
  return Math.abs(y - articleYear);
}

// A single-token show whose token appears in the slug ONLY immediately after
// a location preposition ("in-chicago", "at-chicago") is a place mention, not
// a title mention: "did-reviewers-warm-to-...-iceboy-in-chicago" is about
// Iceboy! at a Chicago venue, not the musical CHICAGO — but "chicago" (7 chars)
// out-scores "iceboy" (6) on the squared-length axis, so without this guard the
// wrong show wins with high confidence (2026-07-08). Multi-token shows are
// never demoted (only their first token can follow the preposition), and a
// demoted candidate still matches when nothing better does ("swept-up-in-
// maybe-happy-ending" keeps matching Maybe Happy Ending).
function _tokenOnlyLocationPrefixed(token, cleanedSlug) {
  let idx = -1;
  let sawOccurrence = false;
  while ((idx = cleanedSlug.indexOf(token, idx + 1)) !== -1) {
    const startOk = idx === 0 || cleanedSlug[idx - 1] === '-';
    const endOk = idx + token.length === cleanedSlug.length || cleanedSlug[idx + token.length] === '-';
    if (!startOk || !endOk) continue;
    sawOccurrence = true;
    const before = cleanedSlug.slice(0, Math.max(0, idx - 1)); // drop the joining '-'
    const prevWord = before.slice(before.lastIndexOf('-') + 1);
    if (prevWord !== 'in' && prevWord !== 'at') return false; // a non-location occurrence exists
  }
  return sawOccurrence;
}

function _matchCleanedSlugAgainstShows(cleanedSlug, shows, options = {}) {
  if (!cleanedSlug || !shows || shows.length === 0) return null;
  const articleYear = options && options.year ? options.year : null;
  const candidates = [];
  for (const show of shows) {
    const tokens = _showDistinctiveTokens(show);
    if (tokens.length === 0) continue;
    // Single-token gate: require ≥5 char token. Lower thresholds admit
    // common 4-char English words as "distinctive tokens" — `home`, `life`,
    // `data`, `cats`, `fish`, `rent`, `fame`, `town`, `news`, etc. — and
    // every aggregator slug containing those words gets matched to the
    // wrong show via the squared-length tiebreaker. Discovered 2026-05-27
    // ship-check (Codex): a 4-char gate produced 241 NEW misroutes in the
    // 38K-file audit. Shows with single 3-4 char title tokens (e.g. "An
    // Ark") are intentionally rejected — too noisy without a second
    // supporting token. The HOLIDAY INN regression that motivated the
    // title-token switch is fixed without lowering this gate because
    // "Holiday Inn" has 2 tokens [holiday, inn], not 1.
    if (tokens.length === 1 && tokens[0].length < 5) continue;
    let matchedTokens = 0;
    let score = 0;       // sum of matched-token-length squared
    let totalLen = 0;
    for (const t of tokens) {
      if (_tokenAppearsInSlug(t, cleanedSlug)) {
        matchedTokens++;
        score += t.length * t.length;
        totalLen += t.length;
      }
    }
    if (matchedTokens === 0) continue;
    // Require ALL show-distinctive tokens to appear in the slug. This is the
    // critical gate that prevents `shakespeares-cabaret-1981` (1 of 2 tokens
    // matched: "shakespeares") from beating `bedlams-othello-off-broadway-
    // 2026` (2 of 2 matched) on a Bedlam Othello slug. Also stops
    // `monte-cristo-the-york-theatre-company-off-broadway` (1 of 5 tokens:
    // "theatre") from matching a "Dad Don't Read This At St Luke's Theatre"
    // slug. The matcher's job is to recognize when a show's title appears
    // in a slug — partial matches are not recognition, they're noise.
    if (matchedTokens < tokens.length) continue;
    const locPrefixed = tokens.length === 1 && _tokenOnlyLocationPrefixed(tokens[0], cleanedSlug);
    candidates.push({ show, matched: matchedTokens, total: tokens.length, score, totalLen, locPrefixed });
  }
  if (candidates.length === 0) return null;
  // Sort by:
  //   1. squared-length score desc (longer + more distinctive tokens win;
  //      naturally favors all-tokens-match for multi-word shows like
  //      Bedlam's Othello, while letting Kenrex beat New-York-New-York)
  //   2. total token length desc
  //   3. non-closed shows preferred (article likely about a current prod)
  //   4. more recent openingDate (a 2026 production beats a 2009 production
  //      with the same single-word title — without this, Hamlet@BAM-2026
  //      tied with Hamlet-2009 on every other axis and picked arbitrarily)
  // Location-prepositioned candidates are place mentions, not recognition —
  // drop them entirely. If nothing else matched, the article stays unmatched
  // (→ audit log → human), which is strictly safer than ingesting reviews
  // into the wrong show.
  const viable = candidates.filter(c => !c.locPrefixed);
  if (viable.length === 0) return null;
  candidates.length = 0;
  candidates.push(...viable);
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.totalLen !== a.totalLen) return b.totalLen - a.totalLen;
    // Date-context axis (only when an article year is supplied via
    // options.year). Prefer a production whose opening is within ±2 years of
    // the article date, then closest by year. Inserted BELOW token-match but
    // ABOVE the closed/recency heuristics: for same-token-set productions
    // (e.g. a bare "Cabaret" slug matching both cabaret-2014 and cabaret-1987)
    // the article date is the only signal that separates them, and it is a
    // stronger signal than "prefer the newer/open one". A missing openingDate
    // yields gap Infinity → never in-window, never wins this axis, so the
    // matcher falls through to the existing recency behavior unchanged.
    if (articleYear) {
      const aGap = _yearGap(a.show, articleYear);
      const bGap = _yearGap(b.show, articleYear);
      const aIn = aGap <= 2 ? 0 : 1;
      const bIn = bGap <= 2 ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;       // in-window candidates first
      // Closest opening year — but ONLY among in-window candidates. When NO
      // candidate is within ±2 years (aIn === bIn === 1), the article date is
      // not a reliable disambiguator (e.g. a 2023 West End "Les Misérables"
      // roundup vs the open WE production whose openingDate is the 1985
      // original — gap 38 — and a closed 2014 Broadway revival — gap 9).
      // Falling through to the closed/recency heuristics below correctly
      // prefers the OPEN current production instead of the year-nearest closed
      // one. Using closest-year here would wrongly route to the 2014 revival.
      if (aIn === 0 && aGap !== bGap) return aGap - bGap;
    }
    const aClosed = (a.show.status || '').toLowerCase() === 'closed' ? 1 : 0;
    const bClosed = (b.show.status || '').toLowerCase() === 'closed' ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;
    const aYear = parseInt((a.show.openingDate || '').slice(0, 4), 10) || 0;
    const bYear = parseInt((b.show.openingDate || '').slice(0, 4), 10) || 0;
    return bYear - aYear;
  });
  return { show: candidates[0].show, confidence: 'high', via: 'slug-token-set' };
}

/**
 * @param {string} rawSlug
 * @param {Object[]} shows
 * @param {Object} [options] - { year } article publish year for same-title
 *   disambiguation. PV slugs carry no date, so the caller supplies it (e.g.
 *   scrape-playbill-verdict.js derives it from article.publishDate).
 */
function matchSlugToShow(rawSlug, shows, options = {}) {
  if (!rawSlug || !shows || shows.length === 0) return null;
  let stripped = _stripPvHead(String(rawSlug).toLowerCase().replace(/^\/?article\//, ''));
  stripped = _stripPvTail(stripped);
  return _matchCleanedSlugAgainstShows(stripped, shows, options);
}

// ---------------------------------------------------------------------------
// BroadwayWorld Review-Roundup slug helpers
//
// BWW roundup URLs:
//   /article/Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526
//   /article/Review-Roundup-INDIAN-PRINCESSES-Opens-at-Atlantic-Theater-Company
//   /article/Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway
//   /article/Review-Roundup-THE-PEOPLE-VERSUS-LENNY-BRUCE-Off-Broadway
//
// Always SHOUTY-CAPS with hyphens. Prefix `Review-Roundup-`. Tail patterns:
// `-Opens-(Off-)?Broadway-YYYYMMDD`, `-(Off-)?Broadway`, `-Opens-at-VENUE`.
// Lowercasing first means we can reuse the same substring-match infrastructure.
// ---------------------------------------------------------------------------

const BWW_HEAD_PATTERNS = [
  /^review-roundup-/,
];

const BWW_TAIL_PATTERNS = [
  /-opens-(off-)?broadway-?\d{0,8}$/,
  /-opens-on-broadway-?\d{0,8}$/,
  /-on-broadway-?\d{0,8}$/,
  /-off-broadway-?\d{0,8}$/,
  /-opens-at-.*$/,
  /-broadway-?\d{0,8}$/,
  /-\d{8}$/,  // bare trailing YYYYMMDD
];

/**
 * Match a BWW Review-Roundup article URL slug to a show in shows.json.
 * @param {string} rawSlug - either full URL or just the slug part after /article/
 * @param {Object[]} shows - shows.json array
 * @param {Object} [options] - { year } overrides the slug-derived article year.
 * @returns {{ show: Object, confidence: 'high', via: 'slug-substring' } | null}
 */
function matchBwwRoundupSlugToShow(rawSlug, shows, options = {}) {
  if (!rawSlug || !shows || shows.length === 0) return null;
  // Accept either /article/Review-Roundup-... or just the slug
  let s = String(rawSlug).toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/?article\//, '');
  // Extract the article date from the raw slug tail BEFORE the tail patterns
  // strip it. BWW roundup slugs end in -YYYYMMDD (e.g. ...-20211213). This is
  // the only signal that separates same-title productions (a 2021 West End
  // "Cabaret" review vs the 2014/1987 Broadway revivals) and lets the misroute
  // audit flag findings whose matched show is years from the article date. An
  // explicit options.year overrides the slug-derived year.
  let articleYear = options && options.year ? options.year : null;
  if (!articleYear) {
    const m = s.match(/-(\d{8})$/);
    if (m) {
      const y = parseInt(m[1].slice(0, 4), 10);
      if (y >= 1900 && y <= 2100) articleYear = y;
    }
  }
  for (const p of BWW_HEAD_PATTERNS) s = s.replace(p, '');
  for (const p of BWW_TAIL_PATTERNS) s = s.replace(p, '');
  return _matchCleanedSlugAgainstShows(s, shows, { ...options, year: articleYear });
}

/**
 * Apply the matcher's source-specific head/tail strip to a raw article
 * slug. Audit + apply scripts use this to mirror exactly what the matcher
 * sees — keeping the strip patterns canonical in this file.
 * @param {string} rawSlug
 * @param {'pv'|'bww'} source
 */
function cleanSlugForMatcher(rawSlug, source) {
  if (!rawSlug || typeof rawSlug !== 'string') return '';
  let s = rawSlug.toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/?article\//, '');
  if (source === 'bww') {
    for (const p of BWW_HEAD_PATTERNS) s = s.replace(p, '');
    for (const p of BWW_TAIL_PATTERNS) s = s.replace(p, '');
  } else {
    s = _stripPvHead(s);
    s = _stripPvTail(s);
  }
  return s;
}

module.exports = {
  matchTitleToShow,
  loadShows,
  cleanExternalTitle,
  normalizeTitle,
  titleToSlug,
  buildLondonSlugVariants,
  titleWordsMatch,
  titleWordsMatchWithConfidence,
  validateRoundupPageTitle,
  cleanSlugTitle,
  isVerdictReviewSlug,
  matchSlugToShow,
  matchBwwRoundupSlugToShow,
  // Matcher internals — exported so audit/apply scripts share one source
  // of truth with the matcher. Duplicating these in audit-* scripts was
  // a documented bug (post-2026-05-27 code-design review).
  cleanSlugForMatcher,
  _showDistinctiveTokens,
  _tokenAppearsInSlug,
  _SLUG_STOPWORDS,
  TITLE_GENERIC_WORDS,
  KNOWN_ALIASES,
};
