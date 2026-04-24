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
 * If a target year is provided, picks the production with closest opening year.
 * Otherwise, picks the most recent production.
 */
function pickBestProduction(matches, targetYear, preferredMarket, prefer) {
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
 * @returns {{ show: Object, confidence: 'high'|'medium' } | null}
 */
function matchTitleToShow(externalTitle, shows, options) {
  if (!externalTitle || !shows || shows.length === 0) return null;

  const targetYear = options?.year || null;
  const preferredMarket = options?.market || null;
  const prefer = options?.prefer || null;
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
    const exactMatches = [];
    for (const show of shows) {
      const showTitle = (show.title || '').toLowerCase().trim();
      if (showTitle === variant) {
        exactMatches.push(show);
      }
    }
    if (exactMatches.length > 0) {
      return { show: pickBestProduction(exactMatches, targetYear, preferredMarket, prefer), confidence: 'high' };
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
        return { show: pickBestProduction(aliasMatches, targetYear, preferredMarket, prefer), confidence: 'high' };
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
      return { show: pickBestProduction(normalizedMatches, targetYear, preferredMarket, prefer), confidence: 'high' };
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
        return { show: pickBestProduction(wordMatches, targetYear, preferredMarket, prefer), confidence: 'medium' };
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

  // Zero meaningful words — very low confidence
  if (words.length === 0) {
    const rawTitle = showTitleLower.split(/[\s,]+/)[0];
    const matched = rawTitle && rawTitle.length >= 3 && matchesAsWholeWord(rawTitle, candidateLower);
    return { matched, confidence: matched ? 0.3 : 0, matchCount: matched ? 1 : 0, threshold: 1, words: rawTitle ? [rawTitle] : [] };
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

module.exports = {
  matchTitleToShow,
  loadShows,
  cleanExternalTitle,
  normalizeTitle,
  titleToSlug,
  buildLondonSlugVariants,
  titleWordsMatch,
  titleWordsMatchWithConfidence,
  TITLE_GENERIC_WORDS,
  KNOWN_ALIASES,
};
