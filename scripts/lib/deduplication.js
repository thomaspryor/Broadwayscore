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
const { normalizeVenueName, getMarketPool } = require('./venue-classification');

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
  'the lion king': ['the lion king', 'lion king', 'disneys the lion king', 'the lion king the musical'],
  'hercules': ['hercules', 'disneys hercules', 'hercules the musical'],
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
  'all out': ['all out', 'all out comedy about ambition'],
  'stranger things': ['stranger things', 'stranger things the first shadow'],
  'harry potter': ['harry potter', 'harry potter and the cursed child', 'harry potter and the cursed child parts one and two'],
  // IBDB imports individual one-acts/double bills as separate entries — these are single productions
  'relatively speaking': ['relatively speaking', 'talking cure', 'george is dead', 'honeymoon motel'],
  'sea wall a life': ['sea wall a life', 'sea wall', 'a life'],
  // Multi-part productions — IBDB has separate pages per part but reviews cover the whole production
  'angels in america': ['angels in america', 'angels in america millennium approaches', 'angels in america perestroika'],
  'the coast of utopia': ['the coast of utopia', 'the coast of utopia voyage', 'the coast of utopia shipwreck', 'the coast of utopia salvage'],
  'the norman conquests': ['the norman conquests', 'the norman conquests table manners', 'the norman conquests living together', 'the norman conquests round and round the garden'],
};

/**
 * Generate a slug from a title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // Strip diacritics (é→e)
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '') // Strip everything except alphanumeric, spaces, hyphens
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Normalize a title for comparison - strips subtitles, articles, punctuation
 * to catch variations like "All Out: Comedy About Ambition" vs "All Out".
 *
 * Also strips a leading author/brand possessive prefix so titles like
 * "Thornton Wilder's The Emporium" → "emporium", letting the upstream pair
 * collapse onto an existing "The Emporium" record. The prefix-stripping is
 * tolerated because cross-production false-positives are caught by the
 * `isMultiProduction` check in the duplicate scan (year gap, venue mismatch).
 *
 * The Emporium 2026-05-03 dup landed because the prefix allowlist only
 * covered "Disney's" / "Roald Dahl's" — see memory/feedback_possessive_prefix_dedup.md.
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
    // Remove a leading author/brand possessive prefix (1-3 words ending in 's),
    // e.g. "Disney's", "Thornton Wilder's", "Andrew Lloyd Webber's", "Bob Fosse's".
    // Curly + ASCII apostrophe both accepted. The trailing article (the/a/an)
    // is also stripped so "Thornton Wilder's The Emporium" → "emporium".
    .replace(/^(?:[a-z][a-z0-9.\-]*\s+){0,2}[a-z][a-z0-9.\-]*['’]s\s+(?:the\s+|a\s+|an\s+)?/i, '')
    // Re-strip leading article (in case the possessive removal exposed one)
    .replace(/^(the|a|an)\s+/i, '')
    // Clean up punctuation and extra spaces
    .replace(/[!?'":\-–—,\.+\/]/g, '')
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

  // For short titles (< 6 chars), require 90% similarity
  // For longer titles, 85% is sufficient
  const threshold = maxLen < 6 ? 0.9 : 0.85;

  // Length difference alone exceeds max allowed edit distance — skip Levenshtein
  // (Levenshtein distance >= |len1 - len2|, so similarity can never reach threshold)
  if (Math.abs(title1.length - title2.length) > maxLen * (1 - threshold)) return false;

  const distance = levenshteinDistance(title1, title2);
  const similarity = 1 - (distance / maxLen);

  return similarity >= threshold;
}

/**
 * Check if a title matches any known duplicate pattern
 */
function checkKnownDuplicates(newTitleNormalized, existingTitleNormalized) {
  // Check if both titles belong to the same known duplicate group
  for (const [key, variants] of Object.entries(KNOWN_DUPLICATES)) {
    const matchesVariant = (title) => variants.some(v => {
      if (v === title) return true;
      // Match title.includes(v) only if variant appears as a whole word/prefix
      // Prevents "six" matching "sixteen wounded" while keeping "six" matching "six the musical"
      if (title.includes(v)) {
        const idx = title.indexOf(v);
        const afterChar = title[idx + v.length];
        // Variant must be at start or preceded by space, and followed by space/end
        const atWordBoundary = (idx === 0 || title[idx - 1] === ' ') && (!afterChar || afterChar === ' ');
        if (atWordBoundary) return true;
      }
      // Only match v.includes(title) if title is at least 80% of variant length
      // Prevents "ann" matching "annie", "doubt" matching "doubtfire" etc.
      if (v.includes(title) && title.length >= v.length * 0.8) return true;
      return false;
    });

    if (matchesVariant(newTitleNormalized) && matchesVariant(existingTitleNormalized)) {
      return { isDuplicate: true, group: key };
    }
  }

  return { isDuplicate: false, group: null };
}

/**
 * Check if two shows are different productions of the same title.
 * Returns true if both have year info and opening years differ by >2 years.
 */
function isMultiProduction(newShow, existing) {
  // Prefer openingDate (actual production date) over ID suffix (may be historical).
  // e.g., "phantom-west-end-1986" has ID year 1986 but openingDate 2021-07-27.
  const getYear = (show) => {
    if (show.openingDate) return new Date(show.openingDate).getFullYear();
    const idMatch = (show.id || show.slug || '').match(/-(\d{4})$/);
    if (idMatch) return parseInt(idMatch[1]);
    return null;
  };

  // If both have different IBDB URLs, they are definitively separate productions
  const newIbdb = newShow.ibdbUrl || '';
  const existingIbdb = existing.ibdbUrl || '';
  if (newIbdb && existingIbdb && newIbdb !== existingIbdb) {
    return true;
  }

  // Transfers within the same market pool (e.g., off-broadway → broadway)
  // are separate productions IF they have different venues. Same venue +
  // same pool + same title = duplicate, not a transfer (e.g., Phantom WE
  // was miscategorized as both west-end and off-west-end at His Majesty's).
  const newCat = newShow.category || 'broadway';
  const existingCat = existing.category || 'broadway';
  // normalizeVenueName handles apostrophes, parentheticals, trailing Theatre/Theater.
  // Also strip dash-suffixes (e.g., "The Other Palace - Main Theatre" → "the other palace").
  const stripDash = v => v.replace(/\s*[-–—]\s*.+$/, '');
  const newVenueNorm = newShow.venue ? stripDash(normalizeVenueName(newShow.venue)) : '';
  const existVenueNorm = existing.venue ? stripDash(normalizeVenueName(existing.venue)) : '';
  const isUnknown = v => !v || v === 'tba' || v === 'tbd';
  const venuesKnownDifferent =
    !isUnknown(newVenueNorm) &&
    !isUnknown(existVenueNorm) &&
    newVenueNorm !== existVenueNorm;
  if (newCat !== existingCat && getMarketPool(newCat) === getMarketPool(existingCat)) {
    if (venuesKnownDifferent) {
      return true; // Different confirmed venues = legitimate transfer
    }
    // Same venue = likely duplicate, not a transfer — fall through to other checks
  }
  // Same category + different confirmed venues = separate productions.
  // Without this, the looser possessive-prefix normalizeTitle (Thornton Wilder's
  // The Emporium → Emporium) would false-positive on cases like
  // "The Band's Visit" (Ethel Barrymore) vs "The Visit" (Lyceum).
  // We do NOT apply this when one side is open/previews — the open-show branch
  // below handles transfer/re-listing semantics for active runs explicitly.
  if (newCat === existingCat && venuesKnownDifferent) {
    const isActive = (s) => s === 'open' || s === 'previews';
    if (!isActive(newShow.status) && !isActive(existing.status)) {
      return true;
    }
  }

  const newYear = getYear(newShow);
  const existingYear = getYear(existing);

  // If the existing show is still running, a new listing for the same title
  // in the same market is usually the same production, not a revival.
  // Exception: if both have year info from OPENING DATES (not just ID suffixes)
  // and differ by >2 years, they are historical entries (e.g., Death of a Salesman 1975 vs 2026).
  // But same venue overrides this — two shows at the same venue = same production.
  if (existing.status === 'open' || existing.status === 'previews') {
    // Same venue + open show = same production, regardless of year gap.
    // Long-running shows (Wicked, Lion King, Phantom) get TodayTix startDates
    // that differ from their original openingDate by 5-25+ years.
    // Exception: if the new show is a closed historical entry (e.g., Chess 1988),
    // it's a legitimate prior production at the same venue, not a re-listing.
    const newIsClosed = newShow.status === 'closed' ||
      (newShow.closingDate && new Date(newShow.closingDate) < new Date());
    if (!newIsClosed) {
      if (newVenueNorm && existVenueNorm && newVenueNorm === existVenueNorm) {
        return false; // Same venue + still running + new show not closed = same production
      }
    }

    // Different or unknown venues: trust year difference from actual openingDates only.
    // ID suffixes (e.g., -2021) are often TodayTix artifacts, not production years.
    const newYearFromDate = newShow.openingDate ? new Date(newShow.openingDate).getFullYear() : null;
    const existYearFromDate = existing.openingDate ? new Date(existing.openingDate).getFullYear() : null;
    if (newYearFromDate && existYearFromDate && Math.abs(newYearFromDate - existYearFromDate) > 2) {
      return true; // Historical entry vs current production (verified by actual dates)
    }
    // No reliable date evidence for different production.
    return false; // Same/close year or missing dates + open show = same production
  }

  if (newYear && existingYear) {
    return Math.abs(newYear - existingYear) > 2;
  }
  return false;
}

/**
 * Check if two shows are in different market pools (NYC vs London).
 * Cross-market shows with the same title are NOT duplicates (e.g., Hamilton BW + Hamilton WE).
 * Shows in the same pool (e.g., west-end + off-west-end) ARE potential duplicates.
 */
function isCrossMarket(newShow, existing) {
  return getMarketPool(newShow.category) !== getMarketPool(existing.category);
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

    // Skip cross-market pairs (e.g., Broadway vs West End) — same title is expected
    if (isCrossMarket(newShow, existing)) continue;

    // Check 1: Exact title match (case-insensitive)
    if (newTitleLower === existingTitleLower) {
      if (isMultiProduction(newShow, existing)) continue;
      return {
        isDuplicate: true,
        reason: `Exact title match: "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 2: Exact slug match
    if (newSlug === existing.slug) {
      if (isMultiProduction(newShow, existing)) continue;
      return {
        isDuplicate: true,
        reason: `Exact slug match: ${existing.slug}`,
        existingShow: existing
      };
    }

    // Check 3: ID-based match (slug portion without year and market suffix)
    const stripIdSuffix = (s) => s.replace(/-(?:west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
    const newIdBase = stripIdSuffix(newSlug);
    const existingIdBase = stripIdSuffix(existing.id || existing.slug);
    if (newIdBase === existingIdBase) {
      if (isMultiProduction(newShow, existing)) continue;
      return {
        isDuplicate: true,
        reason: `ID base match: "${newIdBase}" matches existing "${existing.id}"`,
        existingShow: existing
      };
    }

    // Check 4: Known duplicate patterns (handles short titles like "SIX")
    const knownCheck = checkKnownDuplicates(newTitleNormalized, existingTitleNormalized);
    if (knownCheck.isDuplicate) {
      if (isMultiProduction(newShow, existing)) continue;
      return {
        isDuplicate: true,
        reason: `Known duplicate group "${knownCheck.group}": "${newShow.title}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 5: Normalized title match (catches "Show: Subtitle" vs "Show")
    // FIXED: Changed from > 3 to >= 3 to catch short titles like "SIX"
    if (newTitleNormalized === existingTitleNormalized && newTitleNormalized.length >= 3) {
      if (isMultiProduction(newShow, existing)) continue;
      // Skip if both titles have subtitles but different full titles — multi-part shows
      // e.g., "Angels in America: Millennium Approaches" vs "Angels in America: Perestroika"
      const hasSubtitle = (t) => /[:\-–—\[]/.test(t);
      if (hasSubtitle(newShow.title) && hasSubtitle(existing.title) && newTitleLower !== existingTitleLower) continue;
      return {
        isDuplicate: true,
        reason: `Normalized title match: "${newTitleNormalized}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 6: Slug prefix/containment match
    if (newSlug.length > 4 && existing.slug.length > 4) {
      if (existing.slug.startsWith(newSlug) || newSlug.startsWith(existing.slug)) {
        if (isMultiProduction(newShow, existing)) continue;
        return {
          isDuplicate: true,
          reason: `Slug prefix match: "${newSlug}" vs "${existing.slug}"`,
          existingShow: existing
        };
      }
    }

    // Check 7: Same venue + normalized title starts the same (first 15 chars)
    if (newVenue && existingVenue && newVenue === existingVenue) {
      if (newTitleNormalized.length > 8 && existingTitleNormalized.length > 8 &&
          newTitleNormalized.substring(0, 15) === existingTitleNormalized.substring(0, 15)) {
        // Skip multi-part shows at same venue (e.g., Coast of Utopia parts)
        const hasSubtitle = (t) => /[:\-–—\[]/.test(t);
        if (hasSubtitle(newShow.title) && hasSubtitle(existing.title) && newTitleLower !== existingTitleLower) continue;
        if (isMultiProduction(newShow, existing)) continue;
        return {
          isDuplicate: true,
          reason: `Same venue "${newVenue}" + similar title start`,
          existingShow: existing
        };
      }
    }

    // Check 8: One title contains the other (for titles > 4 chars)
    // Require shorter title to be at least 50% of longer title length
    // to prevent false positives like "doubt" matching "mrs doubtfire"
    if (existingTitleNormalized.length > 4 && newTitleNormalized.length > 4) {
      const shorter = Math.min(existingTitleNormalized.length, newTitleNormalized.length);
      const longer = Math.max(existingTitleNormalized.length, newTitleNormalized.length);
      if (shorter / longer >= 0.5) {
        if (newTitleNormalized.includes(existingTitleNormalized) ||
            existingTitleNormalized.includes(newTitleNormalized)) {
          if (isMultiProduction(newShow, existing)) continue;
          return {
            isDuplicate: true,
            reason: `Title containment: "${newTitleNormalized}" vs "${existingTitleNormalized}"`,
            existingShow: existing
          };
        }
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

/**
 * Globe-incident guard (2026-05-09).
 *
 * Returns the existing show if `candidate` has no openingDate AND there is
 * already a show with an exact title match in the same market pool — in
 * which case the candidate is most likely a poorly-tagged duplicate, not a
 * genuine separate production. checkForDuplicate's venue check otherwise
 * lets it through when the discovery source labels the venue differently
 * from the catalog (TodayTix "Globe Theatre" vs catalog "Shakespeare's
 * Globe"). Without an openingDate we have no positive evidence of a separate
 * production, so refuse to create a new entry.
 *
 * Returns null if no twin found or if the candidate has an openingDate
 * (then we trust the venue evidence and let the standard dedup decide).
 */
function findSameTitleTwinIfNoOpeningDate(candidate, existingShows) {
  if (candidate.openingDate) return null;
  const candTitleLower = (candidate.title || '').toLowerCase().trim();
  if (!candTitleLower) return null;
  const candPool = getMarketPool(candidate.category);
  return existingShows.find(s =>
    (s.title || '').toLowerCase().trim() === candTitleLower &&
    getMarketPool(s.category) === candPool
  ) || null;
}

module.exports = {
  slugify,
  normalizeTitle,
  checkForDuplicate,
  filterDuplicates,
  levenshteinDistance,
  areTitlesSimilar,
  checkKnownDuplicates,
  isCrossMarket,
  getMarketPool,
  findSameTitleTwinIfNoOpeningDate,
  KNOWN_DUPLICATES
};
