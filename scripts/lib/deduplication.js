/**
 * Centralized Show Deduplication Module
 *
 * Provides robust duplicate detection for Broadway shows to prevent
 * automated processes from adding duplicate entries.
 *
 * Used by:
 * - scripts/discover-new-shows.js
 * - scripts/discover-historical-shows.js
 */

/**
 * Known title variations that should be considered duplicates.
 * Maps normalized base titles to their canonical forms.
 * Add entries here when new edge cases are discovered.
 */
const KNOWN_DUPLICATES = {
  // Short titles that need special handling
  'six': ['six', 'six the musical', 'six on broadway'],
  'cats': ['cats', 'cats the musical'],
  'rent': ['rent', 'rent the musical'],
  'hair': ['hair', 'hair the musical'],
  'chess': ['chess', 'chess the musical'],
  'nine': ['nine', 'nine the musical'],
  'sweeney todd': ['sweeney todd', 'sweeney todd the demon barber of fleet street'],
  'les miserables': ['les miserables', 'les mis', 'les miz'],
  'miss saigon': ['miss saigon', 'miss saigon the musical'],
  'annie': ['annie', 'annie the musical'],
  'grease': ['grease', 'grease the musical'],
  'chicago': ['chicago', 'chicago the musical'],
  'cabaret': ['cabaret', 'cabaret the musical'],
  'oklahoma': ['oklahoma', 'oklahoma!'],
  'carousel': ['carousel', 'carousel the musical'],
  'company': ['company', 'company the musical'],
  'pippin': ['pippin', 'pippin the musical'],
  'evita': ['evita', 'evita the musical'],
  'dreamgirls': ['dreamgirls', 'dream girls'],
  'hamilton': ['hamilton', 'hamilton an american musical'],
  'wicked': ['wicked', 'wicked the musical'],
  'aladdin': ['aladdin', 'disneys aladdin', 'aladdin the musical'],
  'frozen': ['frozen', 'disneys frozen', 'frozen the musical'],
  'shrek': ['shrek', 'shrek the musical'],
  'matilda': ['matilda', 'matilda the musical'],
  'hadestown': ['hadestown', 'hades town'],
  'waitress': ['waitress', 'waitress the musical'],
  'beetlejuice': ['beetlejuice', 'beetlejuice the musical'],
  'moulin rouge': ['moulin rouge', 'moulin rouge the musical'],
  'tina': ['tina', 'tina the tina turner musical'],
  'mj': ['mj', 'mj the musical'],
  'back to the future': ['back to the future', 'back to the future the musical'],
  'the outsiders': ['the outsiders', 'outsiders', 'the outsiders a new musical'],
  'water for elephants': ['water for elephants', 'water for elephants the musical'],
  'the great gatsby': ['the great gatsby', 'great gatsby', 'gatsby'],
  'maybe happy ending': ['maybe happy ending', 'maybe happy ending a new musical'],
  'death becomes her': ['death becomes her', 'death becomes her the musical'],
  'the notebook': ['the notebook', 'notebook', 'the notebook a new musical'],
  'gypsy': ['gypsy', 'gypsy a musical'],
  'once upon a mattress': ['once upon a mattress', 'once upon a mattress the musical'],
  'oh mary': ['oh mary', 'oh mary!'],
  'sunset boulevard': ['sunset boulevard', 'sunset blvd'],
  'the hills of california': ['the hills of california', 'hills of california'],
  'left on tenth': ['left on tenth', 'left on 10th'],
  'all in': ['all in', 'all in the fight for democracy'],
  'our town': ['our town', 'thornton wilders our town'],
  'the heart of rock and roll': ['the heart of rock and roll', 'heart of rock and roll'],
  'the wiz': ['the wiz', 'wiz'],
  'suffs': ['suffs', 'the suffs'],
  'stereophonic': ['stereophonic', 'stereo phonic'],
  'the roommate': ['the roommate', 'roommate'],
  'mcneal': ['mcneal', 'mc neal'],
  'yellow face': ['yellow face', 'yellowface'],
  'purpose': ['purpose', 'the purpose'],
  'tammy faye': ['tammy faye', 'eyes of tammy faye', 'tammy faye the musical'],
  'swept away': ['swept away', 'swept away the musical'],
  'eureka day': ['eureka day', 'eureka'],
};

/**
 * Generate a slug from a title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[!?'":\-–—,\.]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Normalize a title for comparison - strips subtitles, articles, punctuation
 * to catch variations like "All Out: Comedy About Ambition" vs "All Out"
 */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    // Remove common subtitles/suffixes
    .replace(/:\s*.+$/, '')           // Remove everything after colon
    .replace(/\s*-\s*.+$/, '')        // Remove everything after dash
    .replace(/\s*\(.+\)$/, '')        // Remove parenthetical at end
    .replace(/\s+on\s+broadway$/i, '') // Remove "on Broadway"
    .replace(/\s+the\s+musical$/i, '') // Remove "The Musical"
    .replace(/\s+a\s+new\s+musical$/i, '') // Remove "A New Musical"
    .replace(/\s+a\s+musical$/i, '')  // Remove "A Musical"
    // Remove articles at start
    .replace(/^(the|a|an)\s+/i, '')
    // Remove possessive prefixes like "Disney's"
    .replace(/^(disney'?s?|roald dahl'?s?)\s+/i, '')
    // Clean up punctuation and extra spaces
    .replace(/[!?'":\-–—,\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  // Create a matrix of size (m+1) x (n+1)
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Check if two titles are similar enough to be considered duplicates
 * using Levenshtein distance
 */
function areTitlesSimilar(title1, title2) {
  const maxLen = Math.max(title1.length, title2.length);
  if (maxLen === 0) return false;

  const distance = levenshteinDistance(title1, title2);
  const similarity = 1 - (distance / maxLen);

  // For short titles (< 6 chars), require 90% similarity
  // For longer titles, 85% is sufficient
  const threshold = maxLen < 6 ? 0.9 : 0.85;

  return similarity >= threshold;
}

/**
 * Check if a title matches any known duplicate pattern
 */
function checkKnownDuplicates(newTitleNormalized, existingTitleNormalized) {
  // Check if both titles belong to the same known duplicate group
  for (const [key, variants] of Object.entries(KNOWN_DUPLICATES)) {
    const newMatches = variants.some(v =>
      v === newTitleNormalized ||
      newTitleNormalized.includes(v) ||
      v.includes(newTitleNormalized)
    );
    const existingMatches = variants.some(v =>
      v === existingTitleNormalized ||
      existingTitleNormalized.includes(v) ||
      v.includes(existingTitleNormalized)
    );

    if (newMatches && existingMatches) {
      return { isDuplicate: true, group: key };
    }
  }

  return { isDuplicate: false, group: null };
}

/**
 * Check if a show might be a duplicate of an existing show
 * Returns { isDuplicate: boolean, reason: string, existingShow: object|null }
 *
 * This is the main entry point for duplicate detection.
 */
function checkForDuplicate(newShow, existingShows) {
  const newSlug = slugify(newShow.title);
  const newTitleLower = newShow.title.toLowerCase().trim();
  const newTitleNormalized = normalizeTitle(newShow.title);
  const newVenue = newShow.venue?.toLowerCase().trim();

  for (const existing of existingShows) {
    const existingTitleLower = existing.title.toLowerCase().trim();
    const existingTitleNormalized = normalizeTitle(existing.title);
    const existingVenue = existing.venue?.toLowerCase().trim();

    // Check 1: Exact title match (case-insensitive)
    if (newTitleLower === existingTitleLower) {
      return {
        isDuplicate: true,
        reason: `Exact title match: "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 2: Exact slug match
    if (newSlug === existing.slug) {
      return {
        isDuplicate: true,
        reason: `Exact slug match: ${existing.slug}`,
        existingShow: existing
      };
    }

    // Check 3: ID-based match (slug portion without year)
    const newIdBase = newSlug;
    const existingIdBase = existing.id?.replace(/-\d{4}$/, '') || existing.slug;
    if (newIdBase === existingIdBase) {
      return {
        isDuplicate: true,
        reason: `ID base match: "${newIdBase}" matches existing "${existing.id}"`,
        existingShow: existing
      };
    }

    // Check 4: Known duplicate patterns (handles short titles like "SIX")
    const knownCheck = checkKnownDuplicates(newTitleNormalized, existingTitleNormalized);
    if (knownCheck.isDuplicate) {
      return {
        isDuplicate: true,
        reason: `Known duplicate group "${knownCheck.group}": "${newShow.title}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 5: Normalized title match (catches "Show: Subtitle" vs "Show")
    // FIXED: Changed from > 3 to >= 3 to catch short titles like "SIX"
    if (newTitleNormalized === existingTitleNormalized && newTitleNormalized.length >= 3) {
      return {
        isDuplicate: true,
        reason: `Normalized title match: "${newTitleNormalized}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 6: Slug prefix/containment match
    if (newSlug.length > 4 && existing.slug.length > 4) {
      if (existing.slug.startsWith(newSlug) || newSlug.startsWith(existing.slug)) {
        return {
          isDuplicate: true,
          reason: `Slug prefix match: "${newSlug}" vs "${existing.slug}"`,
          existingShow: existing
        };
      }
    }

    // Check 7: Same venue + normalized title starts the same (first 8 chars)
    if (newVenue && existingVenue && newVenue === existingVenue) {
      if (newTitleNormalized.length > 4 && existingTitleNormalized.length > 4 &&
          newTitleNormalized.substring(0, 8) === existingTitleNormalized.substring(0, 8)) {
        return {
          isDuplicate: true,
          reason: `Same venue "${newVenue}" + similar title start`,
          existingShow: existing
        };
      }
    }

    // Check 8: One title contains the other (for titles > 4 chars)
    if (existingTitleNormalized.length > 4 && newTitleNormalized.length > 4) {
      if (newTitleNormalized.includes(existingTitleNormalized) ||
          existingTitleNormalized.includes(newTitleNormalized)) {
        return {
          isDuplicate: true,
          reason: `Title containment: "${newTitleNormalized}" vs "${existingTitleNormalized}"`,
          existingShow: existing
        };
      }
    }

    // Check 9: Levenshtein distance for fuzzy matching (for titles > 5 chars)
    if (newTitleNormalized.length > 5 && existingTitleNormalized.length > 5) {
      if (areTitlesSimilar(newTitleNormalized, existingTitleNormalized)) {
        return {
          isDuplicate: true,
          reason: `Fuzzy match (Levenshtein): "${newTitleNormalized}" ~ "${existingTitleNormalized}"`,
          existingShow: existing
        };
      }
    }
  }

  return { isDuplicate: false, reason: null, existingShow: null };
}

/**
 * Batch check multiple shows against existing shows
 * Returns { duplicates: [], newShows: [] }
 */
function filterDuplicates(candidateShows, existingShows) {
  const duplicates = [];
  const newShows = [];

  for (const show of candidateShows) {
    const check = checkForDuplicate(show, existingShows);
    if (check.isDuplicate) {
      duplicates.push({
        show,
        reason: check.reason,
        existingShow: check.existingShow
      });
    } else {
      newShows.push(show);
    }
  }

  return { duplicates, newShows };
}

module.exports = {
  slugify,
  normalizeTitle,
  checkForDuplicate,
  filterDuplicates,
  levenshteinDistance,
  areTitlesSimilar,
  checkKnownDuplicates,
  KNOWN_DUPLICATES
};
