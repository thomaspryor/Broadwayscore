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

// ---------------------------------------------------------------------------
// Known Aliases: External show titles → slugs in shows.json
// ---------------------------------------------------------------------------
const KNOWN_ALIASES = {
  // Harry Potter variations
  'harry potter and the cursed child': 'harry-potter',
  'harry potter': 'harry-potter',
  'cursed child': 'harry-potter',

  // Lion King variations
  'the lion king': 'the-lion-king-1997',
  'lion king': 'the-lion-king-1997',

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

  // Cabaret variations
  'cabaret': 'cabaret-2024',
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

  // Gypsy variations
  'gypsy': 'gypsy-2024',
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
  'cats': 'cats-the-jellicle-ball',
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
 * Match an external show title to a show in shows.json.
 *
 * @param {string} externalTitle - The title from the external source
 * @param {Object[]} shows - Array of show objects from shows.json
 * @returns {{ show: Object, confidence: 'high'|'medium' } | null}
 */
function matchTitleToShow(externalTitle, shows) {
  if (!externalTitle || !shows || shows.length === 0) return null;

  const cleaned = cleanExternalTitle(externalTitle);
  const lowerCleaned = cleaned.toLowerCase().trim();
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
    // 1. Exact title match against shows.json titles
    for (const show of shows) {
      const showTitle = (show.title || '').toLowerCase().trim();
      if (showTitle === variant) {
        return { show, confidence: 'high' };
      }
    }

    // 2. Known aliases → slug → show
    if (KNOWN_ALIASES[variant]) {
      const slug = KNOWN_ALIASES[variant];
      // Alias might point to base slug, need to find with year suffix too
      if (slugToShow[slug]) {
        return { show: slugToShow[slug], confidence: 'high' };
      }
      // Try finding by slug prefix (e.g., 'queen-of-versailles' matches 'queen-of-versailles-2025')
      for (const show of shows) {
        const showSlug = show.slug || show.id;
        if (showSlug.startsWith(slug + '-') || showSlug === slug) {
          return { show, confidence: 'high' };
        }
      }
    }

    // 3. Direct slug match
    const directSlug = titleToSlug(variant);
    if (slugToShow[directSlug]) {
      return { show: slugToShow[directSlug], confidence: 'high' };
    }

    // 4. Normalized match: strip articles, "The Musical", year suffixes
    const normalizedInput = normalizeTitle(variant);
    for (const show of shows) {
      const showSlug = show.slug || show.id;
      const normalizedSlug = showSlug
        .replace(/^(the-|a-|an-)/i, '')
        .replace(/-\d{4}$/, '');  // Strip year suffix
      const normalizedSlugSpaces = normalizedSlug.replace(/-/g, ' ');

      if (normalizedInput === normalizedSlugSpaces) {
        return { show, confidence: 'high' };
      }

      // Also normalize the show title itself
      const normalizedShowTitle = normalizeTitle(show.title || '');
      if (normalizedInput === normalizedShowTitle) {
        return { show, confidence: 'high' };
      }
    }
  }

  // 5. Partial containment (lower confidence) — try all variants
  for (const variant of titleVariants) {
    if (variant.length > 4) {
      for (const show of shows) {
        const showTitle = (show.title || '').toLowerCase().trim();
        if (showTitle.length > 4) {
          if (showTitle.includes(variant) || variant.includes(showTitle)) {
            return { show, confidence: 'medium' };
          }
        }
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

module.exports = {
  matchTitleToShow,
  loadShows,
  cleanExternalTitle,
  normalizeTitle,
  titleToSlug,
  KNOWN_ALIASES,
};
