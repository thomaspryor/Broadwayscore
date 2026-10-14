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
const { foldDiacritics } = require('./title-match');
const { VENUE_ALIASES } = require('./title-match');
// Top-level, not lazy (review catch): text-cleaning.js has no imports of its
// own, so there is no direct or transitive cycle back to this module.
const { decodeHtmlEntities } = require('./text-cleaning');
// transferOf/transferredTo half of isCrossLinked(); show-duplicate-detection
// requires only ./title-match, so there is no cycle back into this module.
const { isDeclaredTransferPair } = require('./show-duplicate-detection');
// Shared id-base rule for Check 3 (S5-T3) — market-slug has no requires of
// its own, so no cycle. validate-shows-prebuild.js uses the same helper.
const { stripIdSuffix: stripIdSuffixUncached } = require('./market-slug');

// Per-string memo for the pure normalizers the O(n²) duplicate scan calls
// once per PAIR (validate-data.js: 3,073 shows → ~4.7M checkForDuplicate
// steps, each re-normalizing the same 3,073 titles/ids). The inputs are a
// few thousand distinct strings; caching them takes the scan from ~90s to a
// few seconds (BRO-4204 audit, 2026-09-29: the S5-T1/T2/T3 per-pair work
// pushed validate-data over the sentinel test's 4-run budget in CI). Bounded
// so a pathological caller can't grow it without limit.
function memoizeByString(fn, cap = 20000) {
  const cache = new Map();
  return function memoized(input) {
    const key = typeof input === 'string' ? input : `\u0000${typeof input}:${String(input)}`;
    if (cache.has(key)) return cache.get(key);
    const value = fn(input);
    if (cache.size >= cap) cache.clear();
    cache.set(key, value);
    return value;
  };
}
const stripIdSuffix = memoizeByString(stripIdSuffixUncached);

/**
 * Alias-table canonical for a venue string, or null when the table has no
 * entry. Unlike title-match's canonicalVenue(), this does NOT fall back to
 * the lossy first-word key — equality semantics here need a real alias hit
 * on BOTH sides ("The New Group" ≡ "Pershing Square Signature Center").
 */
const aliasCanonical = memoizeByString(aliasCanonicalUncached);
function aliasCanonicalUncached(venue) {
  if (!venue) return null;
  for (const { canonical, matches } of VENUE_ALIASES) {
    for (const re of matches) {
      if (re.test(venue)) return canonical;
    }
  }
  return null;
}

/**
 * Safe venue equality — the replacement for every automated-decision call
 * site that used to do `canonicalVenue(a) === canonicalVenue(b)` (title-
 * match.js's canonicalVenue falls back to the lowercased FIRST WORD for any
 * venue outside VENUE_ALIASES, so two unrelated theatres that both start
 * with "The" collapse to the same key — verified live 2026-08-11:
 * canonicalVenue("The Duke on 42nd Street") === canonicalVenue("The Public
 * Theater")). Fine for canonicalVenue's original callers (fuzzy duplicate-
 * detection candidates a human reviews); unsafe for anything making an
 * automated match/skip/corroborate decision off venue equality (BRO-243,
 * generalizing the fix task #1246 shipped locally in aggregator-candidate-
 * extract.js's findKnownObShow/venuesMatch).
 *
 * Reuses two already-shipped, separately-tested helpers instead of adding a
 * third normalization scheme: aliasCanonical() requires a REAL VENUE_ALIASES
 * hit on both sides — no lossy fallback; normalizeVenueName() is an exact
 * (punctuation/whitespace/Theatre-vs-Theater insensitive) full-string
 * comparison for venues the alias table doesn't cover.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function venuesMatch(a, b) {
  if (!a || !b) return false;
  // Decode HTML entities on BOTH sides first (2026-08-30). Scraped venue
  // strings arrive entity-encoded — Playbill returns "St. Ann&#039;s
  // Warehouse" where shows.json holds "St. Ann's Warehouse". Neither
  // aliasCanonical()'s regexes nor normalizeVenueName()'s punctuation
  // stripping treat "&#039;" as an apostrophe, so the encoded side missed the
  // VENUE_ALIASES hit the plain side made and the pair compared UNEQUAL.
  // That reported the same venue as a mismatch and ran Data Validation red on
  // main (kramerfauci-st-anns-off-broadway-2026).
  //
  // Decoded here rather than inside normalizeVenueName because aliasCanonical
  // runs FIRST and would still see the raw entity — and because this keeps the
  // change to the venue-equality DECISION, not to the shared normalizer that
  // 19 other modules import.
  //
  // .trim() here too (BRO-2567). Scraped venue strings routinely arrive padded
  // — 13 shows.json venues carry a trailing space today — and VENUE_ALIASES'
  // regexes are ANCHORED (title-match.js's /^the\s*new\s*group$/i). A padded
  // side therefore missed its alias entirely while the unpadded side hit one,
  // and the `aliasA || aliasB` early return below turned that into a hard
  // false: venuesMatch('  The New Group  ', 'Pershing Square Signature Center')
  // was false where the unpadded form was true. normalizeVenueName() trims,
  // but it runs after this early return, so it never saw these pairs.
  a = decodeVenueString(a);
  b = decodeVenueString(b);
  const aliasA = aliasCanonical(a);
  const aliasB = aliasCanonical(b);
  if (aliasA || aliasB) return aliasA !== null && aliasA === aliasB;
  // The leading-article strip lives in normalizeVenueName() (venue-classification.js:29,
  // added by 43b3e4828df), NOT here. venuesMatch used to carry its own copy so
  // "West End Theatre" would match "The West End Theatre"; once the shared
  // normalizer owned that rule the local copy became actively harmful, because
  // it ran at a DIFFERENT point in the pipeline — before normalizeVenueName's
  // trailing-"Theatre"/"Theater" and parenthetical strips rather than after:
  //
  //   'The Theatre' vs 'The Theater'      -> 'theatre' vs 'theater'  FALSE MISS
  //   'The Theatre' vs 'Theatre Theatre'  -> 'theatre' == 'theatre'  FALSE MATCH
  //   'The (National Theatre)'            -> '' -> force-rejected by normA !== ''
  //
  // Normalizing once, through the one shared normalizer, gets all three right
  // ('the' vs 'the', 'the' vs 'theatre', 'the'). Verified: all 21 venuesMatch
  // assertions across aggregator-candidate-extract.test.mjs and
  // canonical-venue-consumers.test.mjs pass without the local strip, and all
  // 356 distinct shows.json venues normalize identically. (BRO-2567)
  const normA = normalizeVenueNameMemo(a);
  const normB = normalizeVenueNameMemo(b);
  if (normA === '') return false;
  // Separator-insensitive full-name equality: "59E59 Theaters, Theater C" ≡
  // "59E59 Theaters - Theater C". Without it candidate-dedup (the venue-page
  // promotion path) saw two venues and let TodayTix's "Crazy Mama" land as a
  // duplicate of the catalog entry (2026-09-28). Whole-string equality only,
  // so sibling rooms (Theater A vs Theater B) stay distinct.
  return normA === normB || punctFreeVenue(normA) === punctFreeVenue(normB);
}

const punctFreeVenue = memoizeByString(punctFreeVenueUncached);
function punctFreeVenueUncached(v) {
  return String(v || '').replace(/[\s,\-–—]+/g, ' ').trim();
}
// venuesMatch's per-string steps, cached (the O(n²) scan calls venuesMatch
// once per pair; decodeHtmlEntities alone was a third of validate-data's time).
const decodeVenueString = memoizeByString((v) => decodeHtmlEntities(v).trim());
const normalizeVenueNameMemo = memoizeByString((v) => normalizeVenueName(v));

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
  return foldDiacritics(title.toLowerCase()) // Strip diacritics (é→e) — the shared rule (url-slug.js)
    .replace(/[&]/g, 'and')
    // "/" is a word separator ("Electra/Persona"), not punctuation to drop —
    // without this, slugify("Electra/Persona") = "electrapersona" while
    // slugify("Electra / Persona") = "electra-persona" (the surrounding
    // spaces survive to \s+->'-' below; a bare "/" has none), so the same
    // production discovered two ways got two unrelated slugs and every
    // slug/ID-based dup check in checkForDuplicate() missed the pair
    // (electra-persona-west-end-2026 / electrapersona-west-end-2026,
    // BRO-3191, 2026-09-12/13).
    .replace(/\//g, ' ')
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
const normalizeTitle = memoizeByString(normalizeTitleUncached);
function normalizeTitleUncached(title) {
  // foldDiacritics for the same reason slugify() (above) folds: source-listing
  // titles arrive correctly accented while shows.json is inconsistent, so
  // "La Bohème" vs "La Boheme" read as two different shows to the dup scan.
  // Task #648.
  return foldDiacritics(title)
    .toLowerCase()
    // "&" and "and" are one word in a title: "Romeo & Juliet" (Coliseum 2027)
    // and "Romeo and Juliet" (Harold Pinter 2026) must reach the same-venue /
    // year checks below as the same title, not slip past the scan as two
    // (2026-09-29; candidate-dedup and show-matching already fold it).
    .replace(/\s*&\s*/g, ' and ')
    // Remove common subtitles/suffixes
    .replace(/:\s*.+$/, '')           // Remove everything after colon
    .replace(/\s*-\s*.+$/, '')        // Remove everything after dash
    .replace(/\s*\(.+\)$/, '')        // Remove parenthetical at end
    .replace(/\s+on\s+broadway$/i, '') // Remove "on Broadway"
    .replace(/\s+the\s+musical$/i, '') // Remove "The Musical"
    .replace(/\s+a\s+new\s+musical$/i, '') // Remove "A New Musical"
    .replace(/\s+a\s+musical$/i, '')  // Remove "A Musical"
    // Remove a trailing descriptive genre tag that listing sources (esp. TodayTix)
    // append: "The Truth a comedy by Florian Zeller" → "the truth", "Stereophonic
    // a new play" → "stereophonic". The WE 2026 dup slipped both the discovery
    // guard and validate-data's catalog scan because of this tail — see
    // memory/feedback_dedup_genre_suffix.md.
    //
    // GATED on an unambiguous marketing signal — either "new <genre>" OR
    // "<genre> by <Name>" — so an INTEGRAL trailing genre word is left alone.
    // A bare "a/an <genre>" is NOT stripped: "It's Only a Play" must stay
    // "its only a play", not collapse to "only" (the McNally play). The two
    // signal forms cover every real TodayTix listing tail observed. The author
    // name is bounded to a NAME shape (not greedy .+) so it can't swallow
    // arbitrary content; trailing [!?.]* closes the ordering gap with the
    // punctuation cleanup below (this runs before it). "X: A Tragedy" colon
    // forms are already collapsed by the colon rule above.
    .replace(/\s+a\s+new\s+(?:comedy|play|musical|drama|opera|operetta|thriller|farce|tragedy)[!?.]*$/i, '')
    .replace(/\s+an?\s+(?:comedy|play|musical|drama|opera|operetta|thriller|farce|tragedy)\s+by\s+[a-z0-9][a-z0-9.\-'’ ]*[!?.]*$/i, '')
    // Remove articles at start
    .replace(/^(the|a|an)\s+/i, '')
    // Remove a leading author/brand possessive prefix (1-3 words ending in 's),
    // e.g. "Disney's", "Thornton Wilder's", "Andrew Lloyd Webber's", "Bob Fosse's".
    // Curly + ASCII apostrophe both accepted. The trailing article (the/a/an)
    // is also stripped so "Thornton Wilder's The Emporium" → "emporium".
    .replace(/^(?:[a-z][a-z0-9.\-]*\s+){0,2}[a-z][a-z0-9.\-]*['’]s\s+(?:the\s+|a\s+|an\s+)?/i, '')
    // Re-strip leading article (in case the possessive removal exposed one)
    .replace(/^(the|a|an)\s+/i, '')
    // "/" is a word separator, not punctuation to drop — see slugify()'s
    // matching comment (BRO-3191). Must run before the punctuation strip
    // below, which would otherwise concatenate the words on either side.
    .replace(/\//g, ' ')
    // Clean up punctuation and extra spaces
    .replace(/[!?'":\-–—,\.+]/g, '')
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
// Per-title membership in the KNOWN_DUPLICATES groups, cached: the scan used
// to re-run every variant test for both titles on every pair.
const knownDuplicateGroupsFor = memoizeByString((title) => {
  const groups = [];
  for (const [key, variants] of Object.entries(KNOWN_DUPLICATES)) {
    const matches = variants.some(v => {
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
    if (matches) groups.push(key);
  }
  return groups;
});

function checkKnownDuplicates(newTitleNormalized, existingTitleNormalized) {
  // Both titles belong to the same known duplicate group (first group in
  // KNOWN_DUPLICATES order wins, as before).
  const newGroups = knownDuplicateGroupsFor(String(newTitleNormalized || ''));
  if (newGroups.length === 0) return { isDuplicate: false, group: null };
  const existingGroups = knownDuplicateGroupsFor(String(existingTitleNormalized || ''));
  for (const key of newGroups) {
    if (existingGroups.includes(key)) return { isDuplicate: true, group: key };
  }
  return { isDuplicate: false, group: null };
}

/**
 * Slug containment is only duplicate-evidence when the extra portion of the
 * longer slug carries no content: a market/year suffix ("-off-broadway-2026")
 * or a subtitle filler ("-the-musical"). A content-word remainder means a
 * different work sharing a title prefix — e.g. "romeo-and-juliet" vs
 * "romeo-and-juliet-suite" (SitP 2026 incident: the Delacorte Romeo and
 * Juliet was dropped as a duplicate of the Park Avenue Armory dance piece),
 * or "hamlet" vs "hamlet-hail-to-the-thief".
 *
 * Requiring the remainder to start at a hyphen boundary also stops
 * mid-word prefix hits like "anne" vs "annette".
 */
// Bare "play"/"musical" are included because listing sources append them as
// format disambiguators (TodayTix "A Doll's House (Play)" → slug …-play).
const NON_CONTENT_SLUG_REMAINDER_RE = /^(?:-(?:off-broadway|broadway|off-west-end|west-end|on-broadway|the-musical|a-new-musical|a-musical|musical|the-play|a-new-play|a-play|play|in-concert|\d{4}))+$/;

function isSlugContainmentDuplicate(slugA, slugB) {
  if (slugA === slugB) return true;
  const [shorter, longer] = slugA.length <= slugB.length ? [slugA, slugB] : [slugB, slugA];
  if (!longer.startsWith(shorter)) return false;
  return NON_CONTENT_SLUG_REMAINDER_RE.test(longer.slice(shorter.length));
}

// Strict (non-lossy) title equality for the National-Theatre parent/child
// override below — casefold + collapse whitespace + treat "/" as a
// separator, but do NOT strip subtitles/articles/possessives the way
// normalizeTitle() does. normalizeTitle()'s fuzziness is correct for its
// normal callers (Check 5 in checkForDuplicate) but is exactly the wrong
// tool for a check whose failure mode is silent data loss (Codex adversarial
// review, BRO-3191 follow-up): "Hamlet" and "Hamlet: Something Else" must
// stay distinct even though normalizeTitle() strips the subtitle from both.
function strictTitleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// National Theatre (South Bank) runs 3 concurrent auditoria under one site
// name — Olivier, Lyttelton, Dorfman — so aliasing the bare site name to any
// ONE of them in VENUE_ALIASES would be unsafe (the same BAM false-positive
// class that file already documents). But a listing that gives only the BARE
// site name is genuinely ambiguous with ANY one of its auditoria — unlike two
// DIFFERENT named auditoria, which are never the same production (the
// National runs unrelated shows in each concurrently). This is deliberately
// asymmetric and scoped to exactly that one relationship, not a generic
// "venues might be related" heuristic.
const NATIONAL_THEATRE_PARENT = 'national theatre';
const NATIONAL_THEATRE_CHILDREN = ['lyttelton theatre', 'olivier theatre', 'dorfman theatre'];
function isAmbiguousParentChildVenue(venueA, venueB) {
  const a = String(venueA || '').toLowerCase().trim();
  const b = String(venueB || '').toLowerCase().trim();
  const isParent = (v) => v === NATIONAL_THEATRE_PARENT;
  const isChild = (v) => NATIONAL_THEATRE_CHILDREN.includes(v);
  return (isParent(a) && isChild(b)) || (isParent(b) && isChild(a));
}

/**
 * Start-after-close rule (BRO-4204 S5-T1). Two same-title rows in one market
 * are DIFFERENT productions when one of them starts after the other's run
 * has already ended — a transfer (Into the Woods: Bridge closed 2026-05-30 →
 * Noël Coward from 2026-09-22; Arcadia: Old Vic closed 2026-03-21 → Duke of
 * York's from 2026-06-20) or a return engagement at the very same venue
 * (Lost in Del Valle: SoHo Playhouse Apr 9–May 3 → same house from Sept 14).
 * Before this rule isMultiProduction only exempted closed-vs-ANNOUNCED pairs,
 * so an open/previews transfer or return stub with the same title read as
 * the old show (Sprint 0's isCrossLinked stopgap papered over exactly these
 * three) and discovery never proposed it.
 *
 *   1. `candidate` starts (earliest of previewsStartDate /
 *      unconfirmedStartDate / openingDate) strictly AFTER `existing`'s run
 *      ended (closingDate; for a status:'closed' row with no closingDate its
 *      openingDate still dates it — same fallback isLongClosedTwin uses).
 *      Venue-independent on purpose: discovery stubs carry no venue before
 *      enrichment, and a same-venue return is still a new production.
 *   2. With `venuesKnownDifferent` (caller-computed: both venues present
 *      and not matching), `candidate` starts 120+ days after `existing`'s
 *      openingDate — a same-title row at a confirmed-other house four
 *      months on is a transfer, whatever its status.
 *
 * Symmetric: `existing` starting after `candidate`'s run ended is the same
 * evidence (validate-shows-prebuild.js walks shows.json in file order, so
 * either row can be the "candidate"). Returns a short reason string, or null
 * when the dates say nothing (missing/unparseable dates never fire — an
 * undated pair stays whatever the other checks make of it). What does NOT
 * fire: an open twin with no closingDate (long-runners: "after Hamilton
 * opened" is still Hamilton), a candidate starting during the existing run,
 * and the National-Theatre parent/child pairs (same preview date, no close).
 *
 * Callers: isMultiProduction (every checkForDuplicate check), and the
 * openingDate-less twin guard via startsAfterClosedTwin — one rule, so the
 * Globe guard and the duplicate checks can't disagree about the same pair.
 */
const NEW_PRODUCTION_VENUE_GAP_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateMs(value) {
  if (typeof value !== 'string' || !value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

// Earliest parseable start the row carries. previewsStartDate precedes
// openingDate for a real run; unconfirmedStartDate is the quarantined
// TodayTix start (>120d out) discover-new-shows.js keeps out of
// previewsStartDate — taking the minimum is the conservative choice, since
// the rule needs the EARLIEST start to fall after the other run's end.
function earliestStartMs(show) {
  const starts = [show.previewsStartDate, show.unconfirmedStartDate, show.openingDate]
    .map(parseDateMs)
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : NaN;
}

function runEndMs(show) {
  const close = parseDateMs(show.closingDate);
  if (Number.isFinite(close)) return close;
  return show.status === 'closed' ? parseDateMs(show.openingDate) : NaN;
}

function startsAfterExistingRun(candidate, existing, { venuesKnownDifferent = false } = {}) {
  if (!candidate || !existing) return null;
  const nameOf = (s) => s.id || s.title || 'row';
  const afterClose = (a, b) => {
    const startMs = earliestStartMs(a);
    const endMs = runEndMs(b);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    return startMs > endMs ? `${nameOf(a)} starts after ${nameOf(b)} ended (${b.closingDate || b.openingDate})` : null;
  };
  const venueGap = (a, b) => {
    if (!venuesKnownDifferent) return null;
    const startMs = earliestStartMs(a);
    const openMs = parseDateMs(b.openingDate);
    if (!Number.isFinite(startMs) || !Number.isFinite(openMs)) return null;
    const gapDays = Math.floor((startMs - openMs) / DAY_MS);
    return gapDays >= NEW_PRODUCTION_VENUE_GAP_DAYS
      ? `${nameOf(a)} starts at a different venue ${gapDays}d after ${nameOf(b)} opened`
      : null;
  };
  return afterClose(candidate, existing) || afterClose(existing, candidate)
    || venueGap(candidate, existing) || venueGap(existing, candidate);
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
    // Freshly-discovered candidates never carry openingDate before IBDB
    // enrichment (TodayTix/Playbill only ever publish a first-preview date) —
    // fall back to previewsStartDate so a same-venue historical production
    // isn't silently treated as "no year evidence, assume same show" (Gap A,
    // card #1446: a 2026 Winter Garden "Much Ado About Nothing" candidate
    // matched the venue's 1972 production because both openingDate and the
    // ID-suffix year were absent, and the two productions share a venue).
    if (show.previewsStartDate) return new Date(show.previewsStartDate).getFullYear();
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

  // Temporal non-overlap: a definitively closed production cannot be the same as
  // one that is announced/upcoming (hasn't started previews yet). This fires
  // regardless of venue data, which may be missing for newly-added shows.
  const isDefinitelyClosed = (s) => s.status === 'closed' ||
    (s.closingDate && new Date(s.closingDate) < new Date());
  const isNotYetOpen = (s) => s.status === 'announced' || s.status === 'upcoming';
  if ((isDefinitelyClosed(newShow) && isNotYetOpen(existing)) ||
      (isDefinitelyClosed(existing) && isNotYetOpen(newShow))) {
    return true;
  }

  // Opera companies restage the same opera every season — different seasons are
  // different productions (e.g., Met's La Bohème 2025 vs 2026). Use date-based
  // comparison (>180 days) rather than year comparison to correctly handle
  // productions that preview in December but open in January.
  if (newShow.type === 'opera' && existing.type === 'opera') {
    if (newShow.openingDate && existing.openingDate) {
      const daysDiff = Math.abs(new Date(newShow.openingDate) - new Date(existing.openingDate)) / 86400000;
      if (daysDiff > 180) return true;
    } else {
      const newYr = getYear(newShow);
      const existYr = getYear(existing);
      if (newYr && existYr && Math.abs(newYr - existYr) > 1) return true;
    }
  }

  // Transfers within the same market pool (e.g., off-broadway → broadway)
  // are separate productions IF they have different venues. Same venue +
  // same pool + same title = duplicate, not a transfer (e.g., Phantom WE
  // was miscategorized as both west-end and off-west-end at His Majesty's).
  const newCat = newShow.category || 'broadway';
  const existingCat = existing.category || 'broadway';
  // normalizeVenueName handles apostrophes, parentheticals, trailing Theatre/Theater.
  // Also strip dash-suffixes (e.g., "The Other Palace - Main Theatre" → "the other palace").
  // Slash-compound venues ("Classic Stage Company/Lynn F. Angelson Theater" — Playbill's
  // company/house format) are split into segments; two venues match if ANY segment
  // matches, so a compound listing never reads as "known different" from the bare
  // house name a catalog entry carries.
  const stripDash = v => v.replace(/\s*[-–—]\s*.+$/, '');
  // Punctuation-insensitive full name: "59E59 Theaters - Theater C" and
  // "59E59 Theaters, Theater C" are the same room (crazy-mama dup,
  // 2026-09-27), while "..., Theater A" vs "..., Theater B" stay distinct.
  // Deliberately NOT a comma-suffix strip, which would merge sibling rooms.
  const punctFree = v => v.replace(/[\s,\-–—]+/g, ' ').trim();
  const isUnknown = v => !v || v === 'tba' || v === 'tbd';
  const venueSegments = (venue) => !venue ? [] : venue.split('/')
    .map(p => ({ norm: stripDash(normalizeVenueName(p)), full: punctFree(normalizeVenueName(p)), alias: aliasCanonical(p) }))
    .filter(s => !isUnknown(s.norm));
  const newVenueSegs = venueSegments(newShow.venue);
  const existVenueSegs = venueSegments(existing.venue);
  // Segments match on normalized equality OR a shared alias-table canonical
  // (renter company ≡ host venue, e.g. The New Group ≡ Signature Center).
  const venuesMatch = newVenueSegs.some(a => existVenueSegs.some(b =>
    a.norm === b.norm || a.full === b.full || (a.alias && a.alias === b.alias)));
  let venuesKnownDifferent =
    newVenueSegs.length > 0 &&
    existVenueSegs.length > 0 &&
    !venuesMatch;
  // National-Theatre parent/child override (BRO-3191, 2026-09-13, tightened
  // 2026-09-13 per Codex adversarial review of the first version of this
  // fix): electra-persona-west-end-2026 ("National Theatre", previewsStartDate
  // 2026-08-19) vs the discovery-recreated electrapersona-west-end-2026
  // ("Lyttelton Theatre" — one of the National's own auditoria, same date)
  // kept getting classified as separate productions because no VENUE_ALIASES
  // entry links a specific NT auditorium to the bare site name — and unlike
  // Shakespeare's Globe (single main house, aliased above), the National
  // genuinely runs 3 DIFFERENT concurrent shows across Olivier/Lyttelton/
  // Dorfman, so blanket-aliasing "National Theatre" to any one of them would
  // recreate the exact BAM false-positive class this file already guards
  // against.
  //
  // The FIRST version of this override matched on `normalizeTitle()`
  // equality alone, gated only by previewsStartDate + ANY confirmed-
  // different venue. Codex's adversarial review (BRO-3191 follow-up) caught
  // two real false-positive paths that would have shipped: (1) normalizeTitle
  // strips subtitles/articles/possessives, so "Hamlet" and "Hamlet: Something
  // Else" at two genuinely different venues sharing a preview date would
  // silently collapse into "same production" and the second one would never
  // get added — silent data loss, not just a missed duplicate; (2) the
  // override applied globally to every venue pair, not just the National's
  // known parent/child relationship, so it could also suppress two
  // completely unrelated productions elsewhere that happen to share a launch
  // date. Fixed by narrowing on BOTH axes:
  //   - isAmbiguousParentChildVenue(): only fires when one side is the BARE
  //     site name ("National Theatre") and the other is a SPECIFIC named
  //     auditorium (Lyttelton/Olivier/Dorfman) — two different NAMED
  //     auditoria (e.g. Lyttelton vs Olivier) are never treated as ambiguous,
  //     since the National genuinely runs different shows in each.
  //   - strictTitleKey() equality instead of normalizeTitle() equality — no
  //     subtitle/article/possessive stripping, so "Hamlet" vs "Hamlet:
  //     Something Else" no longer match.
  if (venuesKnownDifferent &&
      isAmbiguousParentChildVenue(newShow.venue, existing.venue) &&
      newShow.previewsStartDate && existing.previewsStartDate &&
      newShow.previewsStartDate === existing.previewsStartDate &&
      strictTitleKey(newShow.title) === strictTitleKey(existing.title)) {
    venuesKnownDifferent = false;
  }
  // Start-after-close (S5-T1): one row starting after the other's run ended
  // is a transfer or return engagement, not the same production — see
  // startsAfterExistingRun. Sits after the NT parent/child override so that
  // override's `venuesKnownDifferent = false` reaches the venue-gap clause.
  if (startsAfterExistingRun(newShow, existing, { venuesKnownDifferent })) {
    return true;
  }
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
  // Exception: if the OTHER show is definitively closed, there's no ambiguity —
  // a closed show can't be the same as a current production at a different venue.
  if (newCat === existingCat && venuesKnownDifferent) {
    const isActive = (s) => s === 'open' || s === 'previews';
    if (!isActive(newShow.status) && !isActive(existing.status)) {
      return true;
    }
    if (isDefinitelyClosed(newShow) || isDefinitelyClosed(existing)) {
      return true;
    }
    // One active, one merely announced/upcoming, at CONFIRMED different venues:
    // separate productions. Mirrors the `venuesKnownDifferent` rule in the
    // existing-active branch below, which only fires when `existing` is the
    // active one — without this the check was direction-asymmetric
    // (2026-07-18: Kew "Jack and the Beanstalk" in previews flagged as a
    // duplicate of Hackney Empire's announced Christmas panto).
    if (isNotYetOpen(newShow) || isNotYetOpen(existing)) {
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
      if (venuesMatch) {
        return false; // Same venue + still running + new show not closed = same production
      }
    }

    // Confirmed different venues: always separate productions, regardless of year.
    // An "open" show that moved to a new venue IS a new production, and an "open"
    // show that was wrongly-reopened from TodayTix at a different venue can't be
    // the same as a show currently running elsewhere.
    if (venuesKnownDifferent) return true;

    // Unknown/same venue: trust year difference from actual openingDates only.
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

function colonSegmentKey(t) {
  return foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * True when the shorter title equals exactly one side of the longer title's
 * first colon ("Louis Katz: Conflicted" ~ "Conflicted", "Crazy Mama: A True
 * Story" ~ "Crazy Mama"). Title-only; callers must also require same venue.
 */
// BRO-4381: listing sites drop taglines the catalogue keeps, joined by a
// spaced dash ("ANON – a tempest at our kitchen table") or a "The (New)
// Musical" suffix ("Copperfield! The New Musical"). A colon is not the only
// subtitle separator.
const SUBTITLE_SEPARATOR_RE = /:|\s[–—-]\s/;
const MUSICAL_SUFFIX_RE = /\s+(?:the\s+)?(?:new\s+)?musical$/i;

function isColonSegmentVariant(titleA, titleB) {
  const [short, long] = String(titleA || '').length <= String(titleB || '').length
    ? [titleA, titleB] : [titleB, titleA];
  const longStr = String(long || '');
  const key = colonSegmentKey(short);
  if (key.length < 4 || key === colonSegmentKey(longStr)) return false;
  const m = longStr.match(SUBTITLE_SEPARATOR_RE);
  if (m) {
    const head = longStr.slice(0, m.index);
    const tail = longStr.slice(m.index + m[0].length);
    if (key === colonSegmentKey(head) || key === colonSegmentKey(tail)) return true;
  }
  return MUSICAL_SUFFIX_RE.test(longStr) && key === colonSegmentKey(longStr.replace(MUSICAL_SUFFIX_RE, ''));
}

// Double-bill / pairing separators: " / " (spaced or not), " & ", " and ".
// A lone "/" without spaces is included because slugify/normalizeTitle
// already treat it as a word separator (BRO-3191, "Electra/Persona").
const TITLE_SEGMENT_SEPARATOR_RE = /\s*\/\s*|\s+&\s+|\s+and\s+/i;

const titleSegmentKeys = memoizeByString(titleSegmentKeysUncached);
function titleSegmentKeysUncached(title) {
  return String(title || '')
    .split(TITLE_SEGMENT_SEPARATOR_RE)
    .map(seg => colonSegmentKey(seg).replace(/^(?:the|a|an) /, ''))
    .filter(Boolean);
}

/**
 * True when both titles are the SAME set of two-or-more segments joined by
 * " / ", " & " or " and ", in any order (BRO-4204 S5-T2). The Charing Cross
 * double bill lived under two ids because one listing led with "The Human
 * Voice / The Seven Deadly Sins" and the other with "The Seven Deadly Sins /
 * The Human Voice": every title check reads left-to-right (normalized
 * equality, 15-char prefix, containment, Levenshtein), so a swapped order
 * matched nothing. Segment keys are casefolded, diacritic-folded,
 * punctuation-stripped and lose a leading article; single-segment titles
 * never match (that is Check 1/5's job) and a differing segment set never
 * matches ("Romeo and Juliet" vs "Romeo and Rosaline"). Title-only — the
 * caller (Check 7c) also requires matching venues, like Check 7b.
 */
function isTitleOrderSwap(titleA, titleB) {
  // Cheap guard: a swap needs a separator on BOTH sides; most pairs have none.
  if (!TITLE_SEGMENT_SEPARATOR_RE.test(String(titleA || '')) || !TITLE_SEGMENT_SEPARATOR_RE.test(String(titleB || ''))) return false;
  const a = titleSegmentKeys(titleA);
  const b = titleSegmentKeys(titleB);
  if (a.length < 2 || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((seg, i) => seg === sortedB[i]);
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
 * Two rows that explicitly cross-link each other are different productions
 * by construction: a transfer that names its tryout (`transferOf`), a tryout
 * that names its transfer (`transferredTo`), or a return engagement whose
 * `priorRuns` names the earlier row. Sprint-plan S0-T2b (stopgap until the
 * S5-T1 temporal rule): without this, checkForDuplicate's Check 1 (exact
 * title) fires before any venue/date reasoning and `isMultiProduction` only
 * exempts closed-vs-announced pairs, so an OPEN return/transfer stub with
 * the same title (Into the Woods, Arcadia, Lost in Del Valle, the one-part
 * Cursed Child) fails validate-data's duplicate check.
 *
 * The transferOf/transferredTo half is show-duplicate-detection.js's
 * `isDeclaredTransferPair` (the ticket-identity audit's rule — one
 * definition, not two). Only the priorRuns direction lives here.
 *
 * `priorRuns` entries are `{ openingDate, closingDate, venue, note?,
 * source? }` objects in shows.json today (34 shows, none carry an id; the
 * optional `id` is declared on `PriorRun` in src/types/show.ts); an entry
 * "names" a row when it is the bare id string or an object whose `id` /
 * `showId` / `productionId` equals it. Ids are compared as non-empty
 * strings only, so two rows without ids never read as linked
 * (undefined === undefined). Symmetric in its arguments.
 *
 * `distinctFrom` (string[] of show ids, or { id } objects) is the third
 * link: concurrent sibling productions at one venue that are neither a
 * transfer nor a return (a family panto and its adults-only version).
 * Either row may carry it.
 */
function isCrossLinked(a, b) {
  if (!a || !b) return false;
  if (isDeclaredTransferPair(a, b)) return true;
  const idOf = (s) => (typeof s.id === 'string' && s.id.trim()) ? s.id.trim() : null;
  const namesPriorRun = (show, id) => {
    if (!id) return false;
    const runs = Array.isArray(show.priorRuns) ? show.priorRuns : [];
    return runs.some(r => r === id ||
      (r && typeof r === 'object' && (r.id === id || r.showId === id || r.productionId === id)));
  };
  // `distinctFrom`: an explicit "these are two productions, not one" link
  // for rows the transfer/prior-run vocabulary cannot describe — e.g. the
  // King's Head's family panto and its adults-only twin, running side by side
  // at the same venue with overlapping dates (audit S8-T3). Bare id strings or
  // { id } objects; dangling ids name no row and exempt nothing.
  const namesDistinct = (show, id) => {
    if (!id) return false;
    const list = Array.isArray(show.distinctFrom) ? show.distinctFrom : [];
    return list.some(d => d === id || (d && typeof d === 'object' && d.id === id));
  };
  return namesPriorRun(a, idOf(b)) || namesPriorRun(b, idOf(a))
    || namesDistinct(a, idOf(b)) || namesDistinct(b, idOf(a));
}

/**
 * Full-title key for the multi-part-show skip in checkForDuplicate: case,
 * punctuation and articles removed, subtitle kept. "Going Bacharach: Songs Of
 * An Icon" (TheaterMania) and "Going Bacharach: The Songs of an Icon" are one
 * show (BRO-4381), while "Angels in America: Millennium Approaches" vs
 * "...: Perestroika" still differ.
 */
function subtitleKey(title) {
  return foldDiacritics(String(title || '').toLowerCase())
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

    // Skip opera vs non-opera comparisons — similar-sounding titles are different works
    // (e.g., Verdi's "Otello" should never match Shakespeare's "Othello")
    if ((newShow.type === 'opera') !== (existing.type === 'opera')) continue;

    // Skip rows the candidate is explicitly cross-linked to (transferOf /
    // transferredTo / priorRuns naming the other id) — different productions
    // by construction, before any title check can fire (S0-T2b). Only THIS
    // row is skipped; an un-linked same-title row can still match below.
    if (isCrossLinked(newShow, existing)) continue;

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

    // Check 3: ID-based match (slug portion without year and market suffix).
    // stripIdSuffix is market-slug.js's shared rule (S5-T3) — the private
    // regex that lived here missed `-off-west-end-2026`.
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
      if (hasSubtitle(newShow.title) && hasSubtitle(existing.title) && subtitleKey(newShow.title) !== subtitleKey(existing.title)) continue;
      return {
        isDuplicate: true,
        reason: `Normalized title match: "${newTitleNormalized}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 6: Slug prefix/containment match — only when the longer slug's
    // remainder is non-content (market/year suffix or subtitle filler).
    if (newSlug.length > 4 && existing.slug.length > 4) {
      if (isSlugContainmentDuplicate(newSlug, existing.slug)) {
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
        if (hasSubtitle(newShow.title) && hasSubtitle(existing.title) && subtitleKey(newShow.title) !== subtitleKey(existing.title)) continue;
        if (isMultiProduction(newShow, existing)) continue;
        return {
          isDuplicate: true,
          reason: `Same venue "${newVenue}" + similar title start`,
          existingShow: existing
        };
      }
    }

    // Check 7b: Same venue + one title is exactly one side of the other's
    // colon — "Louis Katz: Conflicted" vs "Conflicted" (TodayTix performer
    // prefix). normalizeTitle() keeps only the pre-colon side ("louis katz"),
    // so Checks 5/7/8 all miss this shape. Exact-segment + venue keeps it tight.
    if (venuesMatch(newShow.venue, existing.venue) && isColonSegmentVariant(newShow.title, existing.title)) {
      if (!isMultiProduction(newShow, existing)) {
        return {
          isDuplicate: true,
          reason: `Same venue + colon-segment title: "${newShow.title}" vs "${existing.title}"`,
          existingShow: existing
        };
      }
    }

    // Check 7c: Same venue + the same double-bill segments in a different
    // order ("The Human Voice / The Seven Deadly Sins" vs "The Seven Deadly
    // Sins / The Human Voice", Charing Cross — S5-T2). See isTitleOrderSwap.
    if (venuesMatch(newShow.venue, existing.venue) && isTitleOrderSwap(newShow.title, existing.title)) {
      if (!isMultiProduction(newShow, existing)) {
        return {
          isDuplicate: true,
          reason: `Same venue + title-order swap: "${newShow.title}" vs "${existing.title}"`,
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
        if (isMultiProduction(newShow, existing)) continue;
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
 * Skipped (returns null) when:
 * - candidate has an openingDate (trust venue evidence; standard dedup decides)
 * - candidate has no title
 * - candidate.category is null/undefined (getMarketPool defaults missing
 *   category to 'broadway'/'nyc' which would falsely bridge a London
 *   candidate with missing category to NYC twins — refuse to decide
 *   without category evidence)
 * - the only same-title shows are long-closed (see isLongClosedTwin): a
 *   candidate currently on sale cannot be the same production as one that
 *   closed 18+ months ago, so it's a revival, not a duplicate. Without this
 *   carve-out the guard permanently blocked real revivals every daily run
 *   (2026-07-14: Seven Guitars/LCT vs 1996, An American Daughter/Signature
 *   vs 1997, You're a Good Man Charlie Brown/City Center vs 1999, and
 *   A View from the Bridge/La MaMa vs 2015 the next day).
 * - the candidate carries an `unconfirmedStartDate` that begins AFTER the
 *   twin's run already ended (see startsAfterClosedTwin). This is the
 *   far-future-season case: discover-new-shows.js quarantines a TodayTix
 *   startDate more than 120 days out rather than trusting it as
 *   previewsStartDate, so a legitimately early-announced subscription season
 *   arrives here with openingDate AND previewsStartDate both null. Before
 *   this carve-out the guard swallowed the entire 2027 Encores! season:
 *   "You're a Good Man, Charlie Brown" (City Center, Feb 3-14 2027) was
 *   blocked on every daily run by the 92NY production that closed
 *   2026-03-29 — inside the 18-month window, so the long-closed carve-out
 *   above never applied (2026-08-12). A show that starts after another
 *   finished is definitionally not that show.
 */
const TWIN_LONG_CLOSED_MONTHS = 18;

function isLongClosedTwin(show) {
  if (show.status !== 'closed') return false;
  // Prefer closingDate; a closed show with only an openingDate still dates it.
  const ref = show.closingDate || show.openingDate;
  if (!ref) return false; // undatable — stay conservative, still counts as a twin
  const refMs = Date.parse(ref);
  if (!Number.isFinite(refMs)) return false;
  return (Date.now() - refMs) > TWIN_LONG_CLOSED_MONTHS * 30.44 * 24 * 60 * 60 * 1000;
}

// True when the candidate's start date (quarantined unconfirmedStartDate, or a
// previewsStartDate — openingDate is null here by construction) falls after
// the twin's run has already finished — positive evidence of a separate
// production even though openingDate is null.
//
// Delegates to startsAfterExistingRun (S5-T1) so the twin guard and
// isMultiProduction can never disagree about the same pair. The twin's end is
// its closingDate — a still-open twin with a FUTURE closingDate counts too (a
// run can't start after it has ended: Pride's Dorfman row was still open in
// July with closingDate 2026-09-12 when the Bridge return for November was
// announced) — or, for a status:'closed' twin with no closingDate, its
// openingDate. An open/upcoming twin with NO closingDate is never cleared
// this way, which is what keeps the original Globe protection and the
// long-running-show protection intact: a candidate whose date is "after
// Hamilton opened in 2015" is still Hamilton. No venue reasoning here on
// purpose (the Globe incident WAS a venue mislabel), so the venue-gap clause
// stays off. Residual risk, accepted knowingly (adversarial review
// 2026-08-12): the quarantined date is by definition not corroborated, so in
// principle a bogus far-future date could clear a twin that IS the same
// production. In practice a recycled TodayTix id never reaches here —
// discover-new-shows.js:1936 dedups on todaytixId before this guard runs, and
// checkForDuplicate (with its venue logic) runs before it too. This is the
// last-resort net, not the first. Every bypass is logged rather than silent
// so a bad one is findable in the run log.
function startsAfterClosedTwin(candidate, twin) {
  const reason = startsAfterExistingRun(candidate, twin);
  if (!reason) return false;
  console.log(`  ↳ twin guard bypassed for "${candidate.title}": ${reason} — treating as a separate production`);
  return true;
}

function findSameTitleTwinIfNoOpeningDate(candidate, existingShows) {
  if (candidate.openingDate) return null;
  const candTitleLower = (candidate.title || '').toLowerCase().trim();
  if (!candTitleLower) return null;
  if (!candidate.category) return null;
  const candPool = getMarketPool(candidate.category);
  return existingShows.find(s =>
    (s.title || '').toLowerCase().trim() === candTitleLower &&
    s.category &&
    getMarketPool(s.category) === candPool &&
    !isLongClosedTwin(s) &&
    !startsAfterClosedTwin(candidate, s)
  ) || null;
}

/**
 * True if `candidateTitle` and `existingTitle` should be treated as the same
 * show once subtitles are stripped (e.g. "Ectoplasm" vs "Ectoplasm: Spit and
 * Vigor" — the 2026-08-04 Deploy-to-Vercel-Failed incident, task #1011).
 * False if they're likely two distinct works sharing a base title (both
 * carry a subtitle marker AND their full titles differ — the Angels in
 * America: Millennium Approaches / Perestroika shape). Reuses the same
 * carve-out checkForDuplicate's Check 5 applies right after its own
 * normalized-title match, so a caller that already has a (candidate,
 * existing) pair doesn't have to re-derive it.
 *
 * This is titles-only — unlike checkForDuplicate, it does NOT run
 * isMultiProduction's protections (differing IBDB URLs, closed-vs-announced,
 * cross-season opera gaps). It is not a drop-in replacement for
 * checkForDuplicate; it is the specific subtitle-variant check that
 * checkForDuplicate ALSO carries, extracted for callers (like the two
 * OB promotion scripts) that already venue-scope their own candidate list
 * and don't want the full duplicate-detection stack.
 *
 * Caller must already have narrowed the comparison to same-venue candidates
 * (or otherwise be certain both titles could plausibly be the same show) —
 * this function only judges titles, not venue.
 *
 * Shared by scripts/promote-ob-venue-candidates.js and
 * scripts/promote-ob-historical.js, which each hand-rolled this logic
 * independently before extraction (2026-08-05) — see scripts/test-deduplication.js
 * for the regression coverage that would have caught both prior bugs.
 */
function isSubtitleVariantOf(candidateTitle, existingTitle) {
  const cStripped = normalizeTitle(candidateTitle);
  const eStripped = normalizeTitle(existingTitle);
  if (cStripped.length < 3 || cStripped !== eStripped) return false;
  const hasSubtitleMarker = (t) => /[:\-–—[]/.test(t);
  const bothHaveSubtitles = hasSubtitleMarker(candidateTitle) && hasSubtitleMarker(existingTitle);
  const fullTitlesDiffer = candidateTitle.toLowerCase().trim() !== existingTitle.toLowerCase().trim();
  return !(bothHaveSubtitles && fullTitlesDiffer);
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
  isCrossLinked,
  getMarketPool,
  isSlugContainmentDuplicate,
  findSameTitleTwinIfNoOpeningDate,
  isLongClosedTwin,
  isSubtitleVariantOf,
  isColonSegmentVariant,
  aliasCanonical,
  venuesMatch,
  KNOWN_DUPLICATES,
  strictTitleKey,
  isAmbiguousParentChildVenue,
  startsAfterExistingRun,
  isTitleOrderSwap,
  NEW_PRODUCTION_VENUE_GAP_DAYS
};
