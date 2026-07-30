/**
 * Review Normalization Module
 *
 * Centralizes all outlet and critic name normalization to prevent duplicate
 * review files from being created with slightly different names.
 *
 * Used by:
 * - scripts/gather-reviews.js (when creating review files)
 * - scripts/build-master-review-list.js (when deduplicating)
 * - scripts/cleanup-duplicate-reviews.js (for fixing existing duplicates)
 *
 * IMPORTANT: The outlet-registry.json is the source of truth for outlet data.
 * When adding new outlet variations, add them to data/outlet-registry.json.
 * When adding known critic name variations, add them to CRITIC_ALIASES below.
 */

/**
 * isPreviewPlaceholder: true — a review file created before openingDate, likely
 * a stub with incomplete fullText or pre-opening aggregator signal. Safe to
 * REPLACE on post-opening discovery. Contrast with a real review (no flag)
 * which must NEVER be replaced by a downstream discovery.
 *
 * This flag is respected by mergeReviews(): when existing.isPreviewPlaceholder
 * is true and the caller passes { fromPostOpening: true }, the incoming review
 * fully replaces the placeholder rather than being merged into it.
 */

const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities } = require('./text-cleaning');
const { logExclusion } = require('./exclusion-logger');

// Score sources from aggregator sites — these are third-party star ratings,
// not the outlet's own score. Used to prevent contamination at both ingestion
// (gather-reviews.js) and merge (mergeReviews below) time.
const AGGREGATOR_SCORE_SOURCES = new Set([
  'theatre-reviews-star-rating', 'westendtheatre-star-rating',
  'show-score-stars', 'stagedoor-star-rating',
  'lbo-star-rating', 'lbo-css-stars', 'thestage-roundup-star-rating',
]);

// Cache for the outlet registry data
let _registryCache = null;
let _registryAliasMap = null;
let _outletAliasesCache = null;

/**
 * Load and cache the outlet registry from JSON file.
 * Returns the registry object with outlets and _aliasIndex.
 */
function loadOutletRegistry() {
  if (_registryCache) return _registryCache;

  try {
    const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
    const data = fs.readFileSync(registryPath, 'utf-8');
    _registryCache = JSON.parse(data);
    return _registryCache;
  } catch (err) {
    console.warn('Warning: Could not load outlet-registry.json, falling back to built-in aliases');
    return null;
  }
}

/**
 * Build a complete alias-to-canonical mapping from the registry.
 * Combines both the aliases arrays from each outlet and the _aliasIndex.
 */
function buildRegistryAliasMap() {
  if (_registryAliasMap) return _registryAliasMap;

  const registry = loadOutletRegistry();
  _registryAliasMap = new Map();

  if (registry) {
    // Add all aliases from outlet definitions
    for (const [outletId, outletData] of Object.entries(registry.outlets || {})) {
      // Map the outlet ID itself
      _registryAliasMap.set(outletId.toLowerCase(), outletId);

      // Map the display name (so "The Arts Fuse" → "artsfuse")
      if (outletData.displayName) {
        _registryAliasMap.set(outletData.displayName.toLowerCase(), outletId);
      }

      // Map all aliases
      if (outletData.aliases) {
        for (const alias of outletData.aliases) {
          _registryAliasMap.set(alias.toLowerCase(), outletId);
        }
      }
    }

    // Add mappings from _aliasIndex (these may include slugified variations)
    if (registry._aliasIndex) {
      for (const [alias, canonicalId] of Object.entries(registry._aliasIndex)) {
        if (alias !== '_note') {
          _registryAliasMap.set(alias.toLowerCase(), canonicalId);
        }
      }
    }
  }

  return _registryAliasMap;
}

/**
 * Build OUTLET_ALIASES-format object from outlet-registry.json.
 * Returns { canonicalId: [alias1, alias2, ...], ... } or null on failure.
 */
function buildOutletAliasesFromRegistry() {
  const registry = loadOutletRegistry();
  if (!registry || !registry.outlets) return null;
  const result = {};
  for (const [outletId, data] of Object.entries(registry.outlets)) {
    if (outletId === '_aliasIndex' || outletId === '_meta') continue;
    const aliases = new Set();
    aliases.add(outletId.toLowerCase());
    for (const a of (data.aliases || [])) {
      aliases.add(a.toLowerCase().trim());
    }
    result[outletId] = [...aliases];
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Get OUTLET_ALIASES — auto-generated from registry, with legacy fallback.
 */
function getOutletAliases() {
  if (_outletAliasesCache) return _outletAliasesCache;
  _outletAliasesCache = buildOutletAliasesFromRegistry();
  if (!_outletAliasesCache) {
    console.error('ERROR: outlet-registry.json not found. Run: ./scripts/setup-local-data.sh');
    _outletAliasesCache = {};
  }
  return _outletAliasesCache;
}

// LEGACY_OUTLET_ALIASES removed — outlet-registry.json is the single source of truth.
// See: data/outlet-registry.json (outlets + _aliasIndex)

let _ambiguousPrefixSlugsCache = null;

/**
 * Slugs that are unsafe to use as a concatenated outlet-critic prefix (see
 * the fuzzy loop in normalizeOutlet) because they are themselves a
 * hyphen-prefix of a DIFFERENT outlet's own registered name. E.g. vulture's
 * alias "new york" is a prefix of nytg's "new-york-theater-guide" and of
 * new-york-sun's "new-york-sun" — treating it as a safe "outlet-critic"
 * prefix silently misrouted "New York Theater Guide" reviews to vulture
 * (card #116). Computed once and cached; registry is static at runtime.
 */
function buildAmbiguousPrefixSlugs() {
  if (_ambiguousPrefixSlugsCache) return _ambiguousPrefixSlugsCache;

  // Pull directly from the registry (not just getOutletAliases()) so
  // displayName variants that aren't duplicated into an outlet's aliases
  // array (e.g. "Lighting & Sound America" vs alias "lighting and sound
  // america") are still counted as that outlet's "own name" — matching what
  // the exact-match phase above already recognizes.
  const registry = loadOutletRegistry();
  const ownSlugsByCanonical = new Map();
  for (const [canonical, data] of Object.entries((registry && registry.outlets) || {})) {
    if (canonical === '_aliasIndex' || canonical === '_meta') continue;
    const slugs = new Set([slugify(canonical)]);
    if (data.displayName) {
      const s = slugify(data.displayName);
      if (s) slugs.add(s);
    }
    for (const alias of (data.aliases || [])) {
      const s = slugify(alias);
      if (s) slugs.add(s);
    }
    ownSlugsByCanonical.set(canonical, slugs);
  }

  const allOwnSlugs = [];
  for (const [canonical, slugs] of ownSlugsByCanonical) {
    for (const slug of slugs) allOwnSlugs.push({ slug, canonical });
  }

  const ambiguous = new Set();
  for (const [canonical, slugs] of ownSlugsByCanonical) {
    for (const prefixSlug of slugs) {
      if (prefixSlug.length < 4) continue;
      const crossesFamily = allOwnSlugs.some(({ slug, canonical: otherCanonical }) =>
        otherCanonical !== canonical && slug.startsWith(prefixSlug + '-')
      );
      if (crossesFamily) ambiguous.add(prefixSlug);
    }
  }

  _ambiguousPrefixSlugsCache = ambiguous;
  return ambiguous;
}

/**
 * Known critic name variations and typos.
 * Maps variations to canonical names.
 * Format: 'canonical-name': ['variation1', 'variation2', ...]
 */
const CRITIC_ALIASES = {
  // IMPORTANT: Only include FULL NAME variations and KNOWN TYPOS.
  // Do NOT include first-name-only aliases (e.g., 'jesse', 'ben') as they
  // will incorrectly match other critics with the same first name.
  'jesse-green': ['jesse green', 'j. green', 'jessie green'],
  'ben-brantley': ['ben brantley', 'b. brantley', 'ben brantly', 'ben branley', 'ben brantely', 'marcus ben brantley'],
  'charles-isherwood': ['charles isherwood', 'c. isherwood', 'charle isherwood', 'charles ishwerwood'],
  'johnny-oleksinski': ['johnny oleksinski', 'johnny oleksinki', 'john oleksinski', 'jonny oleksinski'],
  // Added from Levenshtein audit (Task 1.2) - these were valid matches that need explicit aliases
  'ad-amorosi': ['a.d. amorosi', 'ad amorosi', 'a d amorosi', 'a. d. amorosi'],
  'elisabeth-vincentelli': ['elisabeth vincentelli', 'elizabeth vincentelli', 'elisabeth vincetelli', 'elisabeth vincemtelli', 'elisabeth vincintelli', 'elisabeth vencentelli', 'franklin elisabeth vincentelli'],
  'charles-mcnulty': ['charles mcnulty', 'charlesmcnulty', 'charles-mcnulty', 'chales mcnulty'],
  'sara-holdren': ['sara holdren', 's. holdren', 'sarah holdren', 'sara holden'],
  'helen-shaw': ['helen shaw', 'h. shaw'],
  'adam-feldman': ['adam feldman', 'a. feldman'],
  'david-rooney': ['david rooney', 'd. rooney', 'davod rooney'],
  'frank-scheck': ['frank scheck', 'f. scheck', 'franck scheck', 'frank sheck'],
  'greg-evans': ['greg evans', 'g. evans'],
  'dalton-ross': ['dalton ross', 'd. ross'],
  'aramide-tinubu': ['aramide tinubu', 'aramide timubu', 'arimide timubu'],
  'juan-a-ramirez': ['juan a ramirez', 'juan a. ramirez', 'juan ramirez'],
  'zachary-stewart': ['zachary stewart', 'zach stewart', 'z. stewart'],
  'brittani-samuel': ['brittani samuel', 'b. samuel'],
  'chris-jones': ['chris jones', 'c. jones', 'christopher jones', 'chris jone'],
  'gillian-russo': ['gillian russo', 'g. russo'],
  'jd-knapp': ['jd knapp', 'j.d. knapp', 'j d knapp'],
  'vinson-cunningham': ['vinson cunningham', 'v. cunningham'],
  'naveen-kumar': ['naveen kumar', 'n. kumar', 'naeen kumar', 'naveen kamal'],
  'jonathan-mandell': ['jonathan mandell', 'j. mandell', 'jon mandell', 'jonathan mandrell', 'jonthan mandell', 'jonathan mandel'],
  'brian-scott-lipton': ['brian scott lipton', 'brian lipton', 'b. lipton', 'scott lipton', 'brain scott lipton', 'brian scot lipton', 'brian scott lipon'],
  'melissa-rose-bernardo': ['melissa rose bernardo', 'melissa bernardo', 'm. bernardo', 'rose bernardo'],
  'david-finkle': ['david finkle', 'd. finkle'],
  'david-cote': ['david cote', 'd. cote', 'davide cote'],
  'tim-teeman': ['tim teeman', 't. teeman', 'tom teeman'],
  'kristen-baldwin': ['kristen baldwin', 'k. baldwin'],
  'adrian-horton': ['adrian horton', 'a. horton'],
  'lane-williamson': ['lane williamson', 'l. williamson'],
  'linda-winer': ['linda winer', 'l. winer', 'linda winder'],
  'michael-kuchwara': ['michael kuchwara', 'm. kuchwara'],
  'rex-reed': ['rex reed', 'r. reed', 'red reed'],
  'elysa-gardner': ['elysa gardner', 'e. gardner', 'elyse gardner', 'elysa garder', 'elyssa garner'],
  'peter-marks': ['peter marks', 'p. marks'],
  'matt-windman': ['matt windman', 'm. windman', 'matthew windman', 'matt windham', 'matt windam', 'matt windmand'],
  'robert-hofler': ['robert hofler', 'r. hofler', 'bob hofler', 'robert holfer', 'robert hofter', 'robert hoffler'],
  'steven-suskin': ['steven suskin', 's. suskin', 'steve suskin', 'stephen suskin', 'steven suskind'],
  // Typo variants discovered by Feb 2026 audit
  'hilton-als': ['hilton als', 'hinton als'],
  'michael-feingold': ['michael feingold', 'michal feingold'],
  'leah-greenblatt': ['leah greenblatt', 'lea greenblatt', 'leah glreenblatt', 'leah greenblat'],
  'barbara-schuler': ['barbara schuler', 'barbara shuler', 'barbra schuler'],
  'lovia-gyarkye': ['lovia gyarkye', 'lovia gyarke', 'lovia gayarkye', 'love gyarkye'],
  'thom-geier': ['thom geier', 'thom geir', 'thom geler', 'thom greier', 'thorn geier', 'thomas geier', 'tom geier'],
  'adam-markovitz': ['adam markovitz', 'adam markavitz', 'adam markowitz'],
  'diane-snyder': ['diane snyder', 'diana snyder', 'diane synder'],
  'suzy-evans': ['suzy evans', 'suzt evans'],
  'marilyn-stasio': ['marilyn stasio', 'marilyn stasio.', 'marylin stasio'],
  'rob-weinert-kendt': ['rob weinert-kendt', 'rob weinert- kendt'],
  // Feb 2026 comprehensive audit — new critic entries
  'terry-teachout': ['terry teachout', 't. teachout', 'terry techout', 'terry tecahout', 'tery teachout'],
  'joe-dziemianowicz': ['joe dziemianowicz', 'j. dziemianowicz', 'joe dziemianowizc', 'joe dziemianwoicz', 'joe dzeimianowicz', 'joe dziemianozicz', 'joe dziemianowitz', 'jeo dziemianowicz', 'joe dziemianowics', 'joe dziemianowiczny'],
  'michael-dale': ['michael dale', 'michel dale', 'ichael dale'],
  'scott-brown': ['scott brown', 'scott brow'],
  'frank-rizzo': ['frank rizzo', 'fran rizzo'],
  'nicole-serratore': ['nicole serratore', 'nicole serratori'],
  'tom-gliatto': ['tom gliatto', 'tom gilatto'],
  'danny-groner': ['danny groner', 'dany groner'],
  'trish-deitch': ['trish deitch', 'trish dietch'],
  'christopher-kelly': ['christopher kelly', 'christopher kell', 'christoher kelly'],
  'lester-fabian-brathwaite': ['lester fabian brathwaite', 'fabian brathwaite'],
  'amanda-marie-miller': ['amanda marie miller', 'marie miller'],
  'nancy-van-valkenburg': ['nancy van valkenburg', 'van valkenburg'],
  'nancy-sasso-janis': ['nancy sasso janis', 'sasso janis'],
  'maria-cortes-gonzalez': ['maria cortes gonzalez', 'cortes gonzalez'],
  'david-patrick-stearns': ['david patrick stearns', 'patrick stearns'],
  'david-patrick-stern': ['david patrick stern', 'patrick stern'],
  'ron-fassler': ['ron fassler', 'ron fassler critic'],
  // Feb 2026 Levenshtein similarity audit — new canonical entries
  'robert-feldberg': ['robert feldberg', 'rolbert feldberg'],
  'alexis-soloski': ['alexis soloski', 'alex soloski', 'alexsis soloski'],
  'robert-kahn': ['robert kahn', 'roberth kahn'],
  'mark-shenton': ['mark shenton', 'mark sheton'],
  'brendan-lemon': ['brendan lemon', 'brandan lemon'],
  'jennifer-vanasco': ['jennifer vanasco', 'jennifer vavasco'],
  'dave-quinn': ['dave quinn', 'david quinn'],
  'pete-hempstead': ['pete hempstead', 'peter hempstead'],
  'hayley-levitt': ['hayley levitt', 'haley levitt'],
  'toby-zinman': ['toby zinman', 'tody zinman', 'tony zinman'],
  'philip-boroff': ['philip boroff', 'phillip boroff'],
  'ronni-reich': ['ronni reich', 'ronnie reich'],
  'jose-solis': ['jose solis', 'jose sols'],
  'bedatri-d-choudhury': ['bedatri d choudhury', 'bedatri dchoudhury'],
  'lily-janiak': ['lily janiak', 'lilly janiak'],
  'isabella-biedenharn': ['isabella biedenharn', 'isabella biedenahrn'],
  'kelly-nestruck': ['kelly nestruck', 'j kelly nestruck', 'j. kelly nestruck'],
  'chris-nashawaty': ['chris nashawaty', 'chris nashawty'],
  'michael-j-fressola': ['michael j fressola', 'micael j fressola'],
  'erik-haagensen': ['erik haagensen', 'eric haagensen'],
  'owen-gleiberman': ['owen gleiberman', 'owen glieberman'],
  'alissa-wilkinson': ['alissa wilkinson', 'alissa wiklnson'],
  'david-tereshchuk': ['david tereshchuk', 'david tereschuck'],
  'chris-wiegand': ['chris wiegand', 'chris weigand'],
  'daniel-fienberg': ['daniel fienberg', 'daniel feinberg'],
  'breanne-l-heldman': ['breanne l heldman', 'breanne j heldman'],
  'courtney-castellino': ['courtney castellino', 'courtney castelino'],
  'kerensa-cadenas': ['kerensa cadenas', 'kerensa cardenas'],
  'steven-babyak': ['steven babyak', 'steve babyak'],
  'nilgun-yusuf': ['nilgun yusuf', 'nilg n yusuf', 'nilgün yusuf'],
};

// Merge auto-discovered aliases from weekly integrity workflow
try {
  const autoAliasPath = path.join(__dirname, '..', '..', 'data', 'auto-critic-aliases.json');
  const autoAliases = JSON.parse(fs.readFileSync(autoAliasPath, 'utf8'));
  if (autoAliases.aliases) {
    for (const [canonical, aliases] of Object.entries(autoAliases.aliases)) {
      if (CRITIC_ALIASES[canonical]) {
        for (const a of aliases) {
          if (!CRITIC_ALIASES[canonical].includes(a)) CRITIC_ALIASES[canonical].push(a);
        }
      } else {
        CRITIC_ALIASES[canonical] = aliases;
      }
    }
  }
} catch (e) { /* auto-critic-aliases.json not found or invalid — skip */ }

/**
 * Check if an outlet name resolves to a known/registered outlet.
 * Returns true if the name matches a canonical outlet in the registry or alias map,
 * false if it would just be slugified into a new phantom outlet ID.
 */
function isRegisteredOutlet(outletName) {
  if (!outletName) return false;
  const normalized = normalizeOutlet(outletName);
  const registry = loadOutletRegistry();
  return !!(registry && registry.outlets && registry.outlets[normalized]);
}

/**
 * Normalize an outlet name to its canonical ID.
 * Returns the canonical outlet ID (lowercase, hyphenated).
 *
 * Priority:
 * 1. Check outlet-registry.json (source of truth)
 * 2. Fall back to built-in OUTLET_ALIASES
 * 3. Generate slug from name
 */
function normalizeOutlet(outletName) {
  if (!outletName) return 'unknown';

  // Collapse multiple spaces to single space (e.g., "All That Dazzles  (UK)" → "All That Dazzles (UK)")
  const lower = outletName.toLowerCase().trim().replace(/\s{2,}/g, ' ');
  const withoutThe = lower.replace(/^the\s+/, '');

  // First, check the registry alias map (source of truth)
  const registryAliasMap = buildRegistryAliasMap();
  if (registryAliasMap.size > 0) {
    // Try exact match
    if (registryAliasMap.has(lower)) {
      return registryAliasMap.get(lower);
    }
    // Try without "the " prefix
    if (registryAliasMap.has(withoutThe)) {
      return registryAliasMap.get(withoutThe);
    }
  }

  // Fall back to OUTLET_ALIASES (auto-generated from registry, with legacy fallback)
  const outletAliases = getOutletAliases();
  for (const [canonical, aliases] of Object.entries(outletAliases)) {
    if (aliases.some(alias => {
      // Exact match
      if (lower === alias) return true;
      // Remove "the " prefix and check
      if (withoutThe === alias) return true;
      if (alias.replace(/^the\s+/, '') === lower) return true;
      return false;
    })) {
      return canonical;
    }
  }

  // Check for concatenated outlet-critic patterns (e.g., "variety-frank-rizzo", "new-york-magazinevulture-sara-holdren")
  // These come from upstream data sources that merge outlet and critic names
  const slug = slugify(outletName);
  // Prefixes that also lead a DIFFERENT outlet's own registered name (e.g.
  // vulture's "new york" vs. nytg's "new-york-theater-guide") can never be
  // trusted to mean "outlet + critic name" — exclude them (card #116).
  const ambiguousPrefixSlugs = buildAmbiguousPrefixSlugs();
  for (const [canonical, aliases] of Object.entries(outletAliases)) {
    // Skip short canonical IDs to prevent false prefix matches (e.g., "new", "ap", "ew", "gq")
    if (canonical.length < 4) continue;
    // Check if the slug starts with the canonical outlet ID followed by a critic name
    if (!ambiguousPrefixSlugs.has(slugify(canonical)) && slug.startsWith(canonical + '-') && slug.length > canonical.length + 3) {
      return canonical;
    }
    // Check if the slug starts with any alias (slugified) followed by a critic name
    for (const alias of aliases) {
      const aliasSlug = slugify(alias);
      if (!aliasSlug || ambiguousPrefixSlugs.has(aliasSlug)) continue;
      if (aliasSlug.length >= 4 && slug.startsWith(aliasSlug + '-') && slug.length > aliasSlug.length + 3) {
        return canonical;
      }
      // Also check without separator (e.g., "newyorkmagazinevulture")
      if (aliasSlug.length > 5 && slug.startsWith(aliasSlug) && slug.length > aliasSlug.length + 3) {
        return canonical;
      }
    }
  }

  // Try the slugified form against the registry (catches display-name inputs
  // like "The Arts Fuse" → slug "the-arts-fuse" → registered alias → "artsfuse")
  if (slug !== lower) {
    if (registryAliasMap.has(slug)) {
      return registryAliasMap.get(slug);
    }
    const slugWithoutThe = slug.replace(/^the-/, '');
    if (slugWithoutThe !== slug && registryAliasMap.has(slugWithoutThe)) {
      return registryAliasMap.get(slugWithoutThe);
    }
  }

  // Not found in aliases - create a slug from the name
  return slug;
}

/**
 * Normalize a critic name to its canonical form.
 * Returns the canonical critic name (lowercase, hyphenated).
 */
function normalizeCritic(criticName) {
  if (!criticName) return 'unknown';

  // Clean up garbage prefixes (CSA., MC., etc.) that sometimes appear
  let cleaned = criticName
    .replace(/^(CSA\.|MC\.|MS\.|MR\.|DR\.)\s*/i, '')
    .replace(/^\s*&nbsp;\s*/i, '')
    .trim();

  if (!cleaned) return 'unknown';

  const lower = cleaned.toLowerCase().trim();

  // CMS boilerplate scraped as a byline is not a critic. "Posted By: Aidan
  // O'Connor" extracted as critic "Posted By" minted a phantom MDTG critic and
  // a duplicate review on the live CrazySexyCool page (2026-07-09) — the
  // manual-entry dedup matches on outlet+critic, so a junk byline defeats it.
  // Mapping to 'unknown' routes these through the Unknown-byline guards instead.
  const JUNK_BYLINES = new Set([
    'posted by', 'written by', 'by', 'staff', 'staff writer', 'staff reports',
    'admin', 'administrator', 'editor', 'editorial staff', 'contributor',
    'guest', 'guest contributor', 'press release', 'newsdesk', 'news desk',
  ]);
  if (JUNK_BYLINES.has(lower.replace(/[:.]+$/, '').trim())) return 'unknown';

  // Check against all aliases
  for (const [canonical, aliases] of Object.entries(CRITIC_ALIASES)) {
    if (aliases.some(alias => {
      // Exact match only - no partial/first-name matching
      // (first-name matching was causing Jesse Oxfeld → jesse-green)
      if (lower === alias) return true;
      return false;
    })) {
      return canonical;
    }
  }

  // Not found in aliases - create a slug from the full name
  // But first, ensure we have a reasonable name (at least 2 chars)
  if (lower.length < 2) return 'unknown';

  return slugify(criticName);
}

/**
 * Generate a standardized filename for a review.
 * Format: {outlet}--{critic}.json
 */
function generateReviewFilename(outlet, critic) {
  const normalizedOutlet = normalizeOutlet(outlet);
  const normalizedCritic = normalizeCritic(critic);
  if (isSuspiciousOutletId(normalizedOutlet)) {
    console.warn(`  ⚠️  Suspicious outlet ID in filename: "${normalizedOutlet}" (${outlet})`);
  }
  return `${normalizedOutlet}--${normalizedCritic}.json`;
}

/**
 * Check if an outlet ID looks like a sentence fragment rather than a real outlet.
 * Real outlets are typically under 40 chars with ≤4 hyphens.
 * Sentence fragments like "its-a-brave-writer-who-would-contrive-this-show" are much longer.
 */
function isSuspiciousOutletId(outletId) {
  if (!outletId) return true;
  const hyphenCount = (outletId.match(/-/g) || []).length;
  return outletId.length > 50 || hyphenCount > 6;
}

/**
 * Generate a unique review key for deduplication.
 * This is used to identify the same review across different sources.
 */
function generateReviewKey(outlet, critic) {
  return `${normalizeOutlet(outlet)}|${normalizeCritic(critic)}`;
}

/**
 * Create a slug from text (lowercase, hyphenated, no special chars).
 * Handles HTML entities, Unicode curly quotes, diacritics, and em/en dashes.
 */
function slugify(text) {
  if (!text) return '';
  return decodeHtmlEntities(text)                        // &#8217; → ' (U+2019), &eacute; → é
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')    // Strip diacritics: é → e, ñ → n
    .toLowerCase()
    .trim()
    .replace(/['\u2018\u2019\u2032]/g, '')               // All apostrophe variants (straight + curly + prime)
    .replace(/[\u2013\u2014]/g, '-')                     // Em/en dash → hyphen
    .replace(/[&]/g, 'and')                              // Replace & with and
    .replace(/[^\w\s-]/g, '')                            // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-')                                // Replace spaces with hyphens
    .replace(/-+/g, '-')                                 // Collapse multiple hyphens
    .replace(/^-+|-+$/g, '');                            // Trim hyphens from ends
}

/**
 * Check if two reviews are duplicates based on outlet and critic.
 * Returns true if they represent the same review.
 */
function areReviewsDuplicates(review1, review2) {
  const key1 = generateReviewKey(review1.outlet, review1.criticName);
  const key2 = generateReviewKey(review2.outlet, review2.criticName);
  return key1 === key2;
}

/**
 * Calculate Levenshtein distance between two strings.
 *
 * NOTE: This function is exported for AUDIT/DEBUGGING purposes only.
 * It is NOT used in production critic matching (areCriticsSimilar).
 * Levenshtein matching was removed in Sprint 1 because it caused false positives
 * (e.g., "Helen Smith" incorrectly matching "Helen Smyth").
 *
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance between the two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Check if two critic names are similar enough to be the same person.
 * Handles cases like "Jesse Green" vs "Jesse" or typos.
 */
function areCriticsSimilar(critic1, critic2) {
  if (!critic1 || !critic2) return false;

  const c1 = critic1.toLowerCase().trim();
  const c2 = critic2.toLowerCase().trim();

  // Exact match
  if (c1 === c2) return true;

  // Normalize both
  const n1 = normalizeCritic(critic1);
  const n2 = normalizeCritic(critic2);
  if (n1 === n2) return true;

  // REMOVED: First-name matching caused false positives
  // "Jesse Green" matched "Jesse Oxfeld" (different critics!)
  // Now rely only on explicit aliases in CRITIC_ALIASES

  // REMOVED (Task 1.2): Levenshtein matching caused false positives
  // (e.g., "Helen Smith" matched "Helen Smyth" - different critics!)
  // Now rely only on exact matches and explicit CRITIC_ALIASES.
  // Valid typos discovered via audit were added to CRITIC_ALIASES above.

  return false;
}

/**
 * Check if two outlet names refer to the same outlet.
 */
function areOutletsSame(outlet1, outlet2) {
  if (!outlet1 || !outlet2) return false;
  return normalizeOutlet(outlet1) === normalizeOutlet(outlet2);
}

/**
 * Merge two review objects, keeping the best data from each.
 * Prefers: longer text, more complete URLs, original scores, etc.
 *
 * @param {object} existing - The on-disk review object
 * @param {object} incoming - The newly-discovered review object
 * @param {object} [options]
 * @param {boolean} [options.fromPostOpening] - When true, a placeholder file
 *   (existing.isPreviewPlaceholder === true) will be fully REPLACED by the
 *   incoming review rather than merged. Has no effect on real reviews.
 */
function mergeReviews(existing, incoming, options = {}, context = {}) {
  // Post-opening discovery replaces preview-period placeholder wholesale.
  // Real reviews (no isPreviewPlaceholder flag) are never replaced this way.
  if (existing.isPreviewPlaceholder === true && options.fromPostOpening === true) {
    return { ...incoming };
  }

  // URL analysis runs BEFORE any field merging so the cross-outlet guard
  // below can no-op the whole merge, not just the URL swap.
  //
  // EXCEPTION: if existing URL is marked urlVerified or urlManualOverride,
  // don't auto-overwrite with a different URL. First-URL-set (existing.url
  // is null/undefined) is still allowed — the protection only blocks CHANGES.
  // See: Boy at the Back of the Class thestage URL oscillation (2026-04-10).
  const urlIsProtected = existing.urlVerified === true || existing.urlManualOverride === true;
  const existingUrlLooksBroken = !existing.url || existing.url.includes('undefined');
  // A garbage incoming url ('undefined' fragments, non-http strings like
  // 'N/A' or relative paths) must never REPLACE a real existing url — the
  // invariant below deliberately no-ops on garbage (no state wipe), so
  // adopting the garbage url here would swap the url with no clear, no
  // breadcrumb, and a publishDate refresh (ship-check 2026-07-11). First-set
  // onto an empty/broken url is still allowed for http(s) urls only.
  const incomingUrlGarbage = !!incoming.url && (typeof incoming.url !== 'string'
    || incoming.url.includes('undefined') || !/^https?:\/\//i.test(incoming.url));
  const urlChanged = incoming.url && existing.url && !incomingUrlGarbage
    && normalizeUrl(incoming.url) !== normalizeUrl(existing.url);

  // Cross-outlet guard: an incoming record whose URL the registry maps to a
  // DIFFERENT outlet is another outlet's review — do not merge ANY of it
  // (url, text, critic, dates). Slots whose outletId was minted from a SERP
  // source label (no registry domain) otherwise swallow other outlets'
  // reviews on in-place URL updates — Louise Penn's loureviews.blog reviews
  // were published under the phantom outlet 'Cambridge' this way (her email,
  // 2026-07-12). An unresolvable incoming domain still merges: blocking
  // requires positive evidence of a mismatch, not mere ignorance. And a
  // resolver mismatch is NOT evidence when the existing outlet's own registry
  // entry owns the incoming domain — shared-domain losers (sunday-telegraph
  // on telegraph.co.uk) and domainAliases (ap syndicated on abcnews.go.com)
  // resolve to the domain's primary owner, not the slot's outlet.
  if (urlChanged && existing.outletId && isCrossOutletUrl(existing.outletId, incoming.url)) {
    logExclusion({
      script: context.script || 'unknown-caller',
      showId: context.showId || 'unknown',
      file: context.file || '-',
      reason: 'skippedCrossOutletMerge',
      details: {
        existingUrl: existing.url, incomingUrl: incoming.url, outletId: existing.outletId,
        criticName: existing.criticName,
        incomingResolvedOutletId: (resolveOutletFromUrl(incoming.url) || {}).outletId,
      },
    });
    return { ...existing };
  }

  const merged = { ...existing };

  // Prefer longer/more complete fullText (decode entities on incoming text)
  if (incoming.fullText) {
    const decodedFullText = decodeHtmlEntities(incoming.fullText);
    if (!existing.fullText || decodedFullText.length > existing.fullText.length) {
      merged.fullText = decodedFullText;
    }
  }

  // Prefer valid URLs — and when URL changes, clear stale content flags.
  // This handles preview-article stubs being replaced by real review URLs.
  // Block URL changes only when the existing URL is protected AND not
  // obviously broken. First-URL-set and undefined-repair always proceed.
  const blockUrlChange = urlIsProtected && !existingUrlLooksBroken && urlChanged;
  if (blockUrlChange) {
    logExclusion({
      script: context.script || 'unknown-caller',
      showId: context.showId || 'unknown',
      file: context.file || '-',
      reason: 'skippedBlockedUrlChange',
      details: { existingUrl: existing.url, incomingUrl: incoming.url, outletId: existing.outletId, criticName: existing.criticName },
    });
  }
  if (incoming.url && !incomingUrlGarbage
      && (!existing.url || existing.url.includes('undefined') || urlChanged)
      && !blockUrlChange) {
    merged.url = incoming.url;
    if (urlChanged) {
      // URL moved to a different canonical article. Refresh publishDate and
      // fullText from the incoming record — the fresh URL's text beats any
      // old-URL text regardless of length (the length-preference above was
      // written for same-URL refreshes and would keep the OLD article's
      // longer text here).
      if (incoming.publishDate) merged.publishDate = incoming.publishDate;
      if (incoming.fullText) {
        const decodedIncoming = decodeHtmlEntities(incoming.fullText);
        if (decodedIncoming === decodeHtmlEntities(existing.fullText || '')) {
          // Incoming ECHOES the old article's text (modulo entity encoding)
          // under a new URL — keep the raw existing value so the invariant's
          // deep-equal clears it. Taking the decoded echo would masquerade the
          // old article's text as fresh content for the new URL, and it would
          // then be LLM-scored against the wrong article.
          merged.fullText = existing.fullText;
        } else {
          merged.fullText = decodedIncoming;
        }
      }
      delete merged.wrongArticle;
      // Write-topology invariant (Notion 399637c5): everything derived from
      // the OLD url — wrong flags (including manual wrongShowReason: flagging
      // a file for its URL is really flagging the URL), content state,
      // excerpts, aggregatorStars, LLM scores, old text — must not survive.
      // This replaced a partial hand-rolled clear whose carve-outs (manual
      // wrongShowReason, non-'Same URL' notes, scored content) suppressed the
      // real JCS Palladium reviews on 2026-07-08..10. Date-based
      // wrongProduction flags are still preserved inside the invariant.
      const { applyUrlChangeInvariant } = require('./url-change-invariant');
      applyUrlChangeInvariant(existing, merged, {
        fileLabel: context.file || `${existing.outletId || existing.outlet || '?'}--${existing.criticName || '?'}`,
      });
      merged.urlUpdatedFrom = existing.url;
      merged.urlUpdatedAt = new Date().toISOString();
    }
  }

  // Upgrade Unknown critic name from incoming data
  if (incoming.criticName && incoming.criticName !== 'Unknown'
      && (!existing.criticName || existing.criticName === 'Unknown')
      && !existing.criticNameManual) {
    merged.criticName = incoming.criticName;
  }

  // Keep all excerpts (decode entities on incoming). Gates check `merged`, not
  // `existing`, so a fresh incoming excerpt still lands when the URL-change
  // invariant above just cleared a stale old-URL excerpt (identical behavior
  // to checking `existing` on every other path).
  if (incoming.dtliExcerpt && !merged.dtliExcerpt) {
    merged.dtliExcerpt = decodeHtmlEntities(incoming.dtliExcerpt);
  }
  if (incoming.bwwExcerpt && !merged.bwwExcerpt) {
    merged.bwwExcerpt = decodeHtmlEntities(incoming.bwwExcerpt);
  }
  if (incoming.showScoreExcerpt && !merged.showScoreExcerpt) {
    merged.showScoreExcerpt = decodeHtmlEntities(incoming.showScoreExcerpt);
  }
  if (incoming.nycTheatreExcerpt && !merged.nycTheatreExcerpt) {
    merged.nycTheatreExcerpt = decodeHtmlEntities(incoming.nycTheatreExcerpt);
  }

  // Keep thumb data
  if (incoming.dtliThumb && !existing.dtliThumb) {
    merged.dtliThumb = incoming.dtliThumb;
  }
  if (incoming.bwwThumb && !existing.bwwThumb) {
    merged.bwwThumb = incoming.bwwThumb;
  }

  // Prefer original scores — but NEVER overwrite outlet-verified scores
  // with aggregator scores (prevents theatre-reviews/ShowScore contamination)
  const incomingIsAggregator = AGGREGATOR_SCORE_SOURCES.has(incoming.scoreSource);
  if (incoming.originalScore && !existing.originalScore && !incomingIsAggregator) {
    merged.originalScore = incoming.originalScore;
    merged.originalRating = incoming.originalRating;
  }

  // Keep better publish date
  if (incoming.publishDate && !existing.publishDate) {
    merged.publishDate = incoming.publishDate;
  }

  // Track all sources
  const sources = new Set();
  if (existing.source) sources.add(existing.source);
  if (incoming.source) sources.add(incoming.source);
  if (existing.sources) existing.sources.forEach(s => sources.add(s));
  if (incoming.sources) incoming.sources.forEach(s => sources.add(s));
  merged.sources = Array.from(sources);
  merged.source = merged.sources[0]; // Keep primary source

  // Clear wrongProduction if incoming data has a valid URL and the flag
  // was URL-based (venue transfer self-heal). Date-based flags persist —
  // a URL refresh doesn't change when the review was published. The rebuild's
  // pre-opening guard re-evaluates date-based flags fresh each run, so clearing
  // them here just creates an oscillation loop with the rebuild.
  //
  // Only 'Same URL' (URL-based) auto-clears here. Date-based flag prefixes
  // ('Pre-opening guard', 'Date guard', 'Dateless show') and 'Tour transfer'
  // manual flags must persist until a new valid date or manual override.
  const isUrlBasedWrongProd = !merged.wrongProductionNote
    || merged.wrongProductionNote.startsWith('Same URL');
  if (merged.wrongProduction && incoming.url && incoming.url.startsWith('http')
      && !merged.wrongProductionManualClear
      && isUrlBasedWrongProd) {
    delete merged.wrongProduction;
    delete merged.wrongProductionNote;
    merged.wrongProductionAutoCleared = true;
    merged.wrongProductionAutoClearedAt = new Date().toISOString().slice(0, 10);
  }

  return merged;
}

/**
 * Get the full outlet object from the registry.
 * Returns { displayName, tier, aliases, domain } or null if not found.
 */
// Wire services syndicate on arbitrary partner domains (AP reviews live on
// huffpost.com, sfgate.com, washingtontimes.com, …), so URL-domain identity
// checks can never apply to them. Single source of truth — gather-reviews'
// ingestion domain gate and the mergeReviews cross-outlet guard both use it.
const WIRE_SERVICE_OUTLETS = new Set(['ap', 'reuters', 'bloomberg', 'upi']);

/**
 * Is this URL positive evidence of a DIFFERENT outlet than outletId?
 * True only when the registry maps the URL's domain to another outlet AND
 * outletId's own registry entry does not claim that domain (domain /
 * domainAliases) AND outletId is not a wire service. Used to refuse
 * cross-outlet URL swaps (Louise Penn 'Cambridge' incident, 2026-07-12).
 */
function isCrossOutletUrl(outletId, url) {
  if (!outletId || !url) return false;
  const id = normalizeOutlet(outletId);
  if (WIRE_SERVICE_OUTLETS.has(id)) return false;
  const resolved = resolveOutletFromUrl(url);
  if (!resolved || resolved.outletId === id) return false;
  return !outletOwnsUrlDomain(id, url);
}

/**
 * Does this outlet's own registry entry claim the URL's domain?
 * Checks `domain` plus `domainAliases` (syndication hosts), matching the
 * hostname exactly or as a subdomain. Used by the mergeReviews cross-outlet
 * guard: when two outlets share a domain (telegraph/sunday-telegraph) or an
 * outlet syndicates on another's domain (ap on abcnews.go.com),
 * resolveOutletFromUrl returns the domain's primary owner — the slot's outlet
 * still legitimately owns the URL and must not be blocked.
 */
function outletOwnsUrlDomain(outletId, url) {
  if (!outletId || !url) return false;
  const entry = getOutletFromRegistry(outletId);
  if (!entry) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  const owned = [entry.domain, ...(Array.isArray(entry.domainAliases) ? entry.domainAliases : [])]
    .filter(d => typeof d === 'string' && d)
    .map(d => d.replace(/^www\./, '').toLowerCase());
  return owned.some(d => hostname === d || hostname.endsWith('.' + d));
}

function getOutletFromRegistry(outletId) {
  const registry = loadOutletRegistry();
  if (!registry || !registry.outlets) return null;

  // First normalize the outlet ID
  const normalizedId = normalizeOutlet(outletId);

  // Look up in registry
  return registry.outlets[normalizedId] || null;
}

/**
 * Get the tier for an outlet (1, 2, or 3).
 * Returns 3 (lowest tier) if not found in registry.
 */
function getOutletTier(outletId) {
  const outlet = getOutletFromRegistry(outletId);
  return outlet?.tier || 3;
}

// =====================================================
// CRITIC-OUTLET VALIDATION
// =====================================================

let _criticRegistryCache = null;

/**
 * Load and cache the critic registry from JSON file.
 * Returns null if registry doesn't exist (non-fatal).
 */
function loadCriticRegistry() {
  if (_criticRegistryCache) return _criticRegistryCache;
  try {
    const registryPath = path.join(__dirname, '..', '..', 'data', 'critic-registry.json');
    const data = fs.readFileSync(registryPath, 'utf-8');
    _criticRegistryCache = JSON.parse(data);
    return _criticRegistryCache;
  } catch (err) {
    return null;
  }
}

/**
 * Validate whether a critic is expected at a given outlet.
 * Uses the auto-generated critic registry for data-driven detection.
 *
 * @param {string} critic - Critic name
 * @param {string} outlet - Outlet name or ID
 * @returns {{ isSuspicious: boolean, confidence: string, reason?: string, knownOutlets?: string[] }}
 */
function validateCriticOutlet(critic, outlet) {
  const normalizedCritic = normalizeCritic(critic);
  const normalizedOutlet = normalizeOutlet(outlet);

  if (normalizedCritic === 'unknown' || normalizedOutlet === 'unknown') {
    return { isSuspicious: false, confidence: 'low', reason: 'Unknown critic or outlet' };
  }

  const registry = loadCriticRegistry();
  if (!registry || !registry.critics) {
    return { isSuspicious: false, confidence: 'low', reason: 'No critic registry available' };
  }

  // Look up by slugified critic name
  const criticSlug = normalizedCritic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const criticEntry = registry.critics[criticSlug];
  if (!criticEntry) {
    return { isSuspicious: false, confidence: 'low', reason: 'Critic not in registry' };
  }

  const knownOutlets = criticEntry.knownOutlets || [];
  if (knownOutlets.length === 0) {
    return { isSuspicious: false, confidence: 'low', reason: 'No known outlets for critic' };
  }

  // Freelancers get a pass - they write for many outlets
  if (criticEntry.isFreelancer) {
    return { isSuspicious: false, confidence: 'low', reason: 'Critic is a known freelancer' };
  }

  if (knownOutlets.includes(normalizedOutlet)) {
    return { isSuspicious: false, confidence: 'high' };
  }

  const totalReviews = criticEntry.totalReviews || 0;
  const outletCount = criticEntry.outletCounts?.[normalizedOutlet] || 0;

  // High confidence: 10+ reviews, 0 at this outlet, not a freelancer
  if (totalReviews >= 10 && outletCount === 0) {
    return {
      isSuspicious: true,
      confidence: 'high',
      reason: `${critic} has ${totalReviews} reviews, all at ${knownOutlets.join(', ')} -- never at ${outlet}`,
      knownOutlets,
    };
  }

  // Medium confidence: 5+ reviews, target outlet <10% share
  if (totalReviews >= 5 && outletCount <= 1) {
    return {
      isSuspicious: true,
      confidence: 'medium',
      reason: `${critic} has only ${outletCount}/${totalReviews} reviews at ${outlet}`,
      knownOutlets,
    };
  }

  return { isSuspicious: false, confidence: 'low' };
}

/**
 * Resolve an outlet name from a critic name using the critic registry.
 * Useful when Show-Score extraction gets a null outlet (missing avatar alt text)
 * but has a valid critic name — we can look up their primaryOutlet.
 *
 * @param {string} criticName - The critic's name (display name or slug)
 * @returns {{ outletId: string, displayName: string, isFreelancer: boolean } | null}
 */
function resolveOutletFromCritic(criticName) {
  if (!criticName) return null;

  const registry = loadCriticRegistry();
  if (!registry || !registry.critics) return null;

  // Normalize critic name to slug format for lookup
  const criticSlug = normalizeCritic(criticName);
  if (criticSlug === 'unknown') return null;

  const criticEntry = registry.critics[criticSlug];
  if (!criticEntry || !criticEntry.primaryOutlet) return null;

  const outletId = criticEntry.primaryOutlet;
  const displayName = getOutletDisplayName(outletId);

  return {
    outletId,
    displayName: displayName || outletId,
    isFreelancer: !!criticEntry.isFreelancer,
  };
}

/**
 * Clear the critic registry cache (for testing or after regeneration).
 */
function clearCriticRegistryCache() {
  _criticRegistryCache = null;
}

// Cache for domain-to-outlet reverse index
let _domainToOutletCache = null;

/**
 * Build reverse domain index from outlet-registry.json.
 * Maps domain bases and full hostnames to outlet IDs.
 *
 * Examples:
 *   "nytimes" -> { outletId: "nytimes", displayName: "The New York Times" }
 *   "nytimes.com" -> { outletId: "nytimes", displayName: "The New York Times" }
 */
function buildDomainToOutletIndex() {
  if (_domainToOutletCache) return _domainToOutletCache;

  _domainToOutletCache = new Map();
  const registry = loadOutletRegistry();

  if (registry && registry.outlets) {
    // Two-pass build: primary domains take precedence over domainAliases.
    // This prevents a defunct outlet's stale alias from poisoning a live outlet's
    // primary domain (DoaS Apr 9-10 #7/#8: wolf-entertainment-guide.domainAliases
    // claimed newyorktheatreguide.com, observer.domainAliases claimed
    // theguardian.com — single-pass iteration order made the bug intermittent).
    //
    // Pass 1: register every outlet's primary `domain`.
    //
    // Primary-domain COLLISIONS exist (9 as of 2026-07-11): edition splits
    // (telegraph/sunday-telegraph, express-uk/sunday-express) and registry
    // duplicates (scene/scene-on-stage, theupcoming/the-upcoming-uk, …).
    // The old last-write-wins rule silently handed telegraph.co.uk to
    // sunday-telegraph (iterated later), so EVERY Telegraph URL resolved to
    // the Sunday edition and the shared writer re-homed daily-Telegraph
    // reviews under sunday-telegraph--*.json (card 38b637c5 discovery).
    // Collision rule: the eponymous outlet (id matches the domain base, e.g.
    // 'telegraph' for telegraph.co.uk) wins its own domain; otherwise the
    // FIRST registration wins (registry order lists the primary edition
    // first). A URL can never positively identify the non-eponymous edition
    // of a shared domain — byline/section data has to do that downstream.
    const _idMatchesBase = (id, base) =>
      String(id).replace(/[^a-z0-9]/g, '') === String(base).replace(/[^a-z0-9]/g, '');
    const _claimDomain = (key, entry, base) => {
      const existing = _domainToOutletCache.get(key);
      if (!existing) { _domainToOutletCache.set(key, entry); return; }
      if (existing.outletId === entry.outletId) return;
      if (_idMatchesBase(entry.outletId, base) && !_idMatchesBase(existing.outletId, base)) {
        console.warn(`  ⚠️  Domain collision on "${key}": ${existing.outletId} vs ${entry.outletId} — eponymous ${entry.outletId} wins`);
        _domainToOutletCache.set(key, entry);
        return;
      }
      console.warn(`  ⚠️  Domain collision on "${key}": keeping ${existing.outletId}, ignoring ${entry.outletId}`);
    };
    for (const [outletId, outletData] of Object.entries(registry.outlets)) {
      if (!outletData.domain) continue;
      const entry = { outletId, displayName: outletData.displayName };
      const fullHost = outletData.domain.replace(/^www\./, '').toLowerCase();
      const domainBase = fullHost.split('.')[0];
      _claimDomain(fullHost, entry, domainBase);
      _claimDomain(domainBase, entry, domainBase);
    }

    // Pass 2: register domainAliases ONLY where the key is not already taken
    // by a primary domain. This guarantees a live outlet's primary always wins
    // over any other outlet's alias claiming the same domain.
    for (const [outletId, outletData] of Object.entries(registry.outlets)) {
      if (!outletData.domainAliases) continue;
      const entry = { outletId, displayName: outletData.displayName };
      for (const alias of outletData.domainAliases) {
        const aliasHost = alias.replace(/^www\./, '').toLowerCase();
        const aliasBase = aliasHost.split('.')[0];
        if (!_domainToOutletCache.has(aliasHost)) {
          _domainToOutletCache.set(aliasHost, entry);
        }
        if (!_domainToOutletCache.has(aliasBase)) {
          _domainToOutletCache.set(aliasBase, entry);
        }
      }
    }
  }

  return _domainToOutletCache;
}

/**
 * Resolve an outlet from a URL by matching the domain against outlet-registry.json.
 *
 * @param {string} url - The review URL
 * @returns {{ outletId: string, displayName: string } | null} - Resolved outlet or null
 *
 * Examples:
 *   "https://www.nytimes.com/..." -> { outletId: "nytimes", displayName: "The New York Times" }
 *   "https://culturesauce.com/..." -> { outletId: "culturesauce", displayName: "Culture Sauce" }
 */
function resolveOutletFromUrl(url) {
  if (!url) return null;

  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
    const domainBase = hostname.split('.')[0];

    // Path-aware overrides for shared-domain outlets (before domain lookup)
    // timeout.com hosts both Time Out New York and Time Out London under different paths
    const urlPath = parsedUrl.pathname.toLowerCase();
    if (hostname === 'timeout.com' || hostname === 'timeout.co.uk') {
      if (urlPath.startsWith('/london')) {
        return { outletId: 'timeout-london', displayName: 'Time Out London' };
      }
      return { outletId: 'timeout', displayName: 'Time Out New York' };
    }

    const domainIndex = buildDomainToOutletIndex();

    // Try exact hostname match first
    if (domainIndex.has(hostname)) {
      return domainIndex.get(hostname);
    }

    // Try domain base without TLD
    if (domainIndex.has(domainBase)) {
      return domainIndex.get(domainBase);
    }

    // Try stripping common subdomains: blog.example.com -> example.com
    const withoutSub = hostname.replace(/^(blog|news|review|reviews|arts|entertainment)\./i, '');
    if (withoutSub !== hostname) {
      if (domainIndex.has(withoutSub)) {
        return domainIndex.get(withoutSub);
      }
      const subBase = withoutSub.split('.')[0];
      if (domainIndex.has(subBase)) {
        return domainIndex.get(subBase);
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Clear the domain-to-outlet cache (for testing or after registry updates).
 */
function clearDomainCache() {
  _domainToOutletCache = null;
}

/**
 * Get the canonical display name for an outlet ID.
 * Priority: outlet-registry.json, then built-in fallback.
 */
function getOutletDisplayName(outletId) {
  // First check the registry (source of truth)
  const outlet = getOutletFromRegistry(outletId);
  if (outlet?.displayName) {
    return outlet.displayName;
  }

  // Fall back to built-in display names for outlets not in registry
  const displayNames = {
    'nytimes': 'The New York Times',
    'vulture': 'Vulture',
    'variety': 'Variety',
    'hollywood-reporter': 'The Hollywood Reporter',
    'deadline': 'Deadline',
    'timeout': 'Time Out New York',
    'guardian': 'The Guardian',
    'washpost': 'The Washington Post',
    'wsj': 'The Wall Street Journal',
    'nypost': 'New York Post',
    'nydailynews': 'New York Daily News',
    'ew': 'Entertainment Weekly',
    'theatermania': 'TheaterMania',
    'broadwaynews': 'Broadway News',
    'broadwayworld': 'BroadwayWorld',
    'playbill': 'Playbill',
    'thewrap': 'The Wrap',
    'indiewire': 'IndieWire',
    'observer': 'Observer',
    'newyorker': 'The New Yorker',
    'ap': 'Associated Press',
    'theatrely': 'Theatrely',
    'nysr': 'New York Stage Review',
    'nytg': 'New York Theatre Guide',
    'nyt-theater': 'New York Theater',
    'cititour': 'Cititour',
    'stageandcinema': 'Stage and Cinema',
    'talkinbroadway': "Talkin' Broadway",
    'frontmezzjunkies': 'Front Mezz Junkies',
    'dailybeast': 'The Daily Beast',
    'usatoday': 'USA Today',
    'forward': 'The Forward',
    'rollingstone': 'Rolling Stone',
    'thestage': 'The Stage',
    'chicagotribune': 'Chicago Tribune',
    'latimes': 'Los Angeles Times',
    'sfchronicle': 'San Francisco Chronicle',
    'whatsonstage': "What's On Stage",
    'telegraph': 'The Telegraph',
    'financialtimes': 'Financial Times',
    'billboard': 'Billboard',
    'amny': 'amNewYork',
    'culturesauce': 'Culture Sauce',
    'one-minute-critic': '1 Minute Critic',
    'artsfuse': 'The Arts Fuse',
    'jitney': 'The Jitney',
    'slantmagazine': 'Slant Magazine',
    'buzzfeed': 'BuzzFeed',
    'vox': 'Vox',
    'huffpost': 'HuffPost',
    'nbcnews': 'NBC News',
    'cbsnews': 'CBS News',
    'newsweek': 'Newsweek',
    'time': 'Time',
    'newyorkmagazine': 'New York Magazine / Vulture',
    // New outlets from BWW/DTLI
    'newsday': 'Newsday',
    'npr': 'NPR',
    'njcom': 'NJ.com',
    'dctheatrescene': 'DC Theatre Scene',
    'nbcny': 'NBC New York',
    'londontheatre': 'London Theatre',
    'towncountry': 'Town & Country',
    'vanityfair': 'Vanity Fair',
    'vogue': 'Vogue',
    'artsdesk': 'The Arts Desk',
  };

  return displayNames[outletId] || outletId;
}

/**
 * Normalize a publish date string to a consistent format.
 * - Strips ordinal suffixes (1st, 2nd, 3rd, 4th, etc.)
 * - Returns the cleaned date string
 *
 * Examples:
 *   "November 16th, 2025" -> "November 16, 2025"
 *   "March 1st, 2024" -> "March 1, 2024"
 *   "April 22nd, 2024" -> "April 22, 2024"
 */
function normalizePublishDate(dateStr) {
  if (!dateStr) return dateStr;
  const { stripOrdinals } = require('./date-utils');
  return stripOrdinals(dateStr);
}

/**
 * Find an existing review file for the same outlet in a show directory.
 * Checks all filename variants: normalized outlet ID, raw slug, with/without critic.
 * Returns { path, data } if found, null if no existing file for this outlet.
 *
 * Used by aggregator scrapers to prevent creating duplicate files when different
 * scrapers use different outlet name formats (e.g., "variety-frank-rizzo" vs "variety").
 */
function findExistingReviewFile(showDir, outletName, criticName, url = null) {
  if (!fs.existsSync(showDir)) return null;

  const normalizedOutlet = normalizeOutlet(outletName);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  // Pass 0: match by canonical URL WITHIN THE SAME OUTLET. A review URL uniquely
  // identifies one review, so a re-scrape that extracts a DIFFERENT byline from
  // the page's author list (e.g. WhatsOnStage/Times pages whose byline selector
  // is non-deterministic — one URL → 9 files "whatsonstage--alex-wood",
  // "--alun-hood", … all same body) must merge into the existing file, not spawn
  // a byline variant. Filename is keyed on criticName, so without this the
  // variants accumulate, the write-guard marks them url-collision duplicates, and
  // the real review ends up buried (invalid tier + circular duplicateOf) and never
  // scores. Byline-explosion detector: scripts/audit-review-url-clusters.js.
  //
  // The same-outlet gate is REQUIRED: aggregator roundup URLs are legitimately
  // shared across outlets (one WET/Show-Score/Stagedoor roundup URL backs the
  // Telegraph, FT, Guardian star-stubs — distinct outlets, distinct scores; see
  // feedback_aggregator_roundup_urls_shared_across_outlets). Matching on URL
  // alone would collapse those into one and lose real reviews. canonicalReviewUrl
  // (strips query/hash/trailing-slash — the SAME URL identity the detector uses)
  // is intentionally stronger than the write-guard's normalizeUrl. Skips
  // wrongProduction/duplicateOf files so contamination is never a merge target.
  if (url) {
    const { canonicalReviewUrl } = require('./review-url-clusters');
    const canonUrl = canonicalReviewUrl(url);
    if (canonUrl) {
      for (const file of files) {
        const filePath = path.join(showDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (!data || !data.url || data.wrongProduction || data.duplicateOf) continue;
          const fileOutlet = normalizeOutlet(data.outletId || file.split('--')[0]);
          if (fileOutlet !== normalizedOutlet) continue;
          if (canonicalReviewUrl(data.url) === canonUrl) {
            return { path: filePath, filename: file, data };
          }
        } catch { /* unreadable — skip */ }
      }
    }
  }

  // Pass 1: match by filename prefix (fast path — no file reads needed)
  for (const file of files) {
    const parts = file.replace('.json', '').split('--');
    if (parts.length !== 2) continue;

    const fileOutlet = parts[0];
    const fileCritic = parts[1];

    // Check if file's outlet matches our normalized outlet
    const fileOutletNormalized = normalizeOutlet(fileOutlet);
    if (fileOutletNormalized === normalizedOutlet) {
      // If we have a critic name and file has a different named critic, skip
      // (different critics at same outlet are separate reviews)
      if (criticName && criticName.toLowerCase() !== 'unknown' &&
          fileCritic !== 'unknown') {
        const normalizedCritic = normalizeCritic(criticName);
        const fileNormalizedCritic = normalizeCritic(fileCritic);
        if (normalizedCritic !== fileNormalizedCritic &&
            !areCriticsSimilar(criticName, fileCritic.replace(/-/g, ' '))) {
          continue; // Different critic at same outlet — not a duplicate
        }
      }

      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Skip wrongProduction and duplicateOf files — they should not act as merge targets
        if (data && (data.wrongProduction || data.duplicateOf)) continue;
        return { path: filePath, filename: file, data };
      } catch {
        return { path: filePath, filename: file, data: null };
      }
    }
  }

  // Pass 2: match by outletId stored inside the JSON file.
  // Catches files where the filename prefix doesn't match the stored outletId —
  // e.g. a file named "nytimes--adam-feldman.json" that has outletId: "timeout" inside,
  // caused by bulk fix scripts that update outletId without renaming files.
  // Without this pass, the next write creates a correctly-named duplicate.
  const normalizedCriticForPass2 = criticName && criticName.toLowerCase() !== 'unknown'
    ? normalizeCritic(criticName)
    : null;

  for (const file of files) {
    const parts = file.replace('.json', '').split('--');
    if (parts.length !== 2) continue;

    // Skip files already matched by filename in pass 1 (their outlet normalized to same value)
    const fileOutletNormalized = normalizeOutlet(parts[0]);
    if (fileOutletNormalized === normalizedOutlet) continue; // already checked above

    const filePath = path.join(showDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }
    if (!data || data.wrongProduction || data.duplicateOf) continue;
    if (!data.outletId) continue;

    if (normalizeOutlet(data.outletId) !== normalizedOutlet) continue;

    // Outlet matches by internal field — check critic
    if (normalizedCriticForPass2 && data.criticName) {
      const dataFileCritic = normalizeCritic(data.criticName);
      if (normalizedCriticForPass2 !== dataFileCritic &&
          !areCriticsSimilar(criticName, data.criticName)) {
        continue; // Different critic at same outlet — not a duplicate
      }
    }

    return { path: filePath, filename: file, data };
  }

  // Pass 3: shared-domain outlet dedup via URL resolution.
  // Catches the case where different scrapers use different outlet aliases for the
  // same publication (e.g., "timeout" vs "timeout-london" both on timeout.com).
  // Pass 1 and 2 miss this because the outlet IDs normalize to different canonical values.
  // We only read files where the critic matches AND both outlets share a registered domain.
  const registry = loadOutletRegistry();
  const outletDefs = registry ? (registry.outlets || {}) : {};
  const incomingDomain = outletDefs[normalizedOutlet] ? outletDefs[normalizedOutlet].domain : null;

  if (incomingDomain) {
    const normalizedCriticForPass3 = criticName && criticName.toLowerCase() !== 'unknown'
      ? normalizeCritic(criticName)
      : null;

    for (const file of files) {
      const parts = file.replace('.json', '').split('--');
      if (parts.length !== 2) continue;

      const fileOutletNormalized = normalizeOutlet(parts[0]);
      if (fileOutletNormalized === normalizedOutlet) continue; // already checked in pass 1

      // Check if this file's outlet shares the same domain as the incoming outlet
      const fileDomain = outletDefs[fileOutletNormalized] ? outletDefs[fileOutletNormalized].domain : null;
      if (!fileDomain || fileDomain !== incomingDomain) continue;

      // Critic pre-filter: only proceed if critic matches (avoids unnecessary file reads)
      if (normalizedCriticForPass3) {
        const fileCriticNorm = normalizeCritic(parts[1]);
        if (fileCriticNorm !== normalizedCriticForPass3 &&
            !areCriticsSimilar(criticName, parts[1].replace(/-/g, ' '))) {
          continue;
        }
      }

      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }
      if (!data || data.wrongProduction || data.duplicateOf) continue;

      // Verify via URL resolution: does this file's URL resolve to the incoming outlet?
      // Without URL confirmation, different regional editions on the same domain would
      // be falsely merged (e.g., timeout.com/london vs timeout.com/newyork).
      if (!data.url) continue;
      const resolved = resolveOutletFromUrl(data.url);
      if (!resolved || resolved.outletId !== normalizedOutlet) continue;

      // File's URL resolves to same outlet as incoming — duplicate under a different alias
      return { path: filePath, filename: file, data };
    }
  }

  return null;
}

/**
 * Reject outlet names that are scraping artifacts, not real publications.
 * These slip in when aggregator HTML has ad images with alt text like "advertisement".
 * Check this BEFORE writing review files.
 */
const JUNK_OUTLETS = new Set([
  'advertisement', 'sponsor', 'sponsored', 'promo', 'promotion',
  'unknown', 'null', 'undefined', 'n/a', 'na', 'none',
  'ad', 'ads', 'banner', 'pixel', 'tracking',
  'garth-drabinsky', 'paradise-square',
  'buy-tickets', 'click-here',
  'lets-note', 'lets-go-to-the-theater',
]);

function isJunkOutlet(outletName) {
  if (!outletName) return true;
  const normalized = outletName.toLowerCase().trim();
  if (normalized.length < 2) return true;
  if (JUNK_OUTLETS.has(normalized)) return true;
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (JUNK_OUTLETS.has(slug)) return true;
  // Structural: reject suspiciously long names (45+ chars catches BWW sentence fragments)
  if (slug.length > 45) return true;
  // Too many hyphens — sentence fragments (6+ segments)
  if ((slug.match(/-/g) || []).length > 5) return true;
  // Known garbage patterns from BWW extraction
  if (/photo-credit|average-rating|read-the-reviews|reviewed-its|the-unthinkable/.test(slug)) return true;
  // Starts with conjunctions/verbs that indicate a sentence fragment
  if (/^(but-|and-(?!juliet)|is-a-|is-not-|are-|has-|its-|enjoying-|id-wager|how-to-\w+-is-|does-|turns-|keeps?-|tackles-)/.test(slug)) return true;
  // Contains verb phrases never found in outlet names
  if (/(promises-the|crafted-a|likely-to|fun-surf|wager-that|silence-after|antidote-to|underdog-itself|make-it-fun|speeding-along|seen-on-broadway|rose-to-fame|debacle-of|candid-about|exactly-what|dear-evan-hansen)/.test(slug)) return true;
  // Contains year numbers (19XX/20XX) but not date-formatted — sentence fragments
  if (/(?:19|20)\d{2}/.test(slug) && !/\d{2}-\d{2}/.test(slug)) return true;
  return false;
}

/**
 * Normalize a URL for dedup comparison.
 * Strips protocol, www prefix, trailing slashes, fragments, and tracking params.
 * Returns a canonical string for comparison (NOT a valid URL).
 *
 * Used by:
 * - gather-reviews.js (write-time URL dedup)
 * - cleanup-dedup-comprehensive.js (batch cleanup)
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    let u = url.toLowerCase().trim()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .replace(/#.*$/, '');
    // Tracking-param strip first so any later regex can anchor on the
    // post-strip path/query state.
    u = u.replace(/[?&](utm_\w+|ref|source|fbclid|gclid|partner|emc|_r|smid|campaign|algo|nc|srsltid)=[^&]*/g, '')
      .replace(/\?$/, '')
      .replace(/\?&/, '?');
    // Re-strip trailing slashes: the first strip (above) runs before the
    // query string is removed, so `/review/?utm_source=x` still ends in a
    // slash here and would compare unequal to `/review` — a false "URL
    // changed" signal for the url-change invariant (and a missed dedup).
    u = u.replace(/\/+$/, '');
    // AMP-suffix strip (added 2026-04-28, Item 3 of systematic CI plan).
    // Only matches a path-final `/amp` segment; never a mid-path `/amp/`
    // to avoid false collisions on outlets that legitimately use `/amp/`
    // as a non-AMP route segment. Origin: dracula-west-end-2025
    // metro--brooke-ivey-johnson AMP-URL re-scrape produced a parallel file
    // alongside the canonical metro-uk entry. `/amp` + `?amp=1` are the two
    // BWW/Metro/NYT AMP shapes seen in the corpus. MUST run AFTER tracking
    // strip so URLs like `/foo/amp?utm_source=x` lose the utm and then
    // strip `/amp` cleanly (otherwise `/amp$` doesn't match while `?utm`
    // is still present).
    u = u.replace(/\/amp$/, '').replace(/[?&]amp=1\b/g, '');
    return u;
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

/**
 * Normalize an outlet name and return both the canonical ID and display name.
 * Convenience wrapper combining normalizeOutlet() + getOutletDisplayName().
 */
function normalizeOutletFull(outletName) {
  const outletId = normalizeOutlet(outletName);
  const name = getOutletDisplayName(outletId);
  return { name, outletId };
}

/**
 * Detect URLs that are critic/author profile pages rather than actual reviews.
 * These get scraped from aggregator pages (ShowScore /people/, BWW /people/) but
 * are not review content — they inflate review counts and cause cross-show dupes.
 */
function isProfileUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // BWW critic profiles
  if (/broadwayworld\.com\/people\//.test(lower)) return true;
  // ShowScore critic profiles
  if (/show-score\.com\/people\//.test(lower)) return true;
  // Cititour critic profiles (e.g., /NYC_Broadway/critic/1234)
  if (/cititour\.com\/.*\/\d+$/.test(lower) && !/review/i.test(lower)) return false; // cititour show pages have numeric IDs too
  // Generic author/contributor pages — only match at end of URL path to avoid false positives
  // e.g., /author/jane-doe/ but NOT /author-reviews-hamilton
  if (/\/(?:author|writers?|contributors?|staff|columnists?)\/[^/]+\/?$/.test(lower)) return true;
  // ShowScore /people/ without domain (stored as relative paths)
  if (/^\/people\/[A-Z]/i.test(url)) return true;
  // TheaterMania /shows/ pages are listing pages, not reviews
  if (/theatermania\.com\/shows\//.test(lower)) return true;
  return false;
}

// Generic URL-slug tokens that don't identify a specific show. Excluded from the
// cross-show match below so a shared "review"/"theatre" token can't make e.g. an
// Equus URL look like it belongs to a War Horse review.
const URL_GENERIC_SLUG_TOKENS = new Set([
  // show-agnostic article/section words
  'review', 'reviews', 'roundup', 'roundups', 'round', 'ups', 'news', 'article',
  'culture', 'story', 'stories', 'arts', 'stage', 'play', 'plays', 'musical',
  'musicals', 'tickets', 'production', 'productions', 'opening', 'press', 'night',
  'show', 'shows', 'feature', 'features', 'entertainment', 'post', 'posts',
  // venue / market words common to West End + Broadway slugs
  'theatre', 'theater', 'national', 'west', 'end', 'london', 'broadway',
  'olivier', 'lyttelton', 'cottesloe', 'menier', 'chocolate', 'factory',
  // stopwords that survive slug tokenisation
  'the', 'and', 'for', 'with', 'from', 'are', 'was',
]);

// Distinctive (show-identifying) tokens from a URL slug. Drops generic words,
// pure numbers, and very short fragments.
function _showSlugTokens(url) {
  if (!url) return [];
  const { urlSlugTokens } = require('./show-match-verifier');
  return urlSlugTokens(url).filter(
    (t) => t.length >= 3 && !URL_GENERIC_SLUG_TOKENS.has(t) && !/^\d+$/.test(t)
  );
}

/**
 * True when `newUrl`'s slug clearly identifies a DIFFERENT show than the one
 * described by `refShowTitle` (or, if no title, by `refUrl`'s slug). Returns
 * false when there is no confident signal (no distinctive tokens on either
 * side) so callers fail open. Used to block combined-roundup cross-show
 * contamination at both the URL-upgrade and empty-fill paths.
 */
function slugLooksLikeDifferentShow(newUrl, { showTitle, refUrl } = {}) {
  const newTokens = new Set(_showSlugTokens(newUrl));
  if (!newTokens.size) return false;
  let refTokens = [];
  if (showTitle) {
    const { titleTokens } = require('./show-match-verifier');
    refTokens = titleTokens(showTitle);
  }
  if (!refTokens.length) refTokens = _showSlugTokens(refUrl || '');
  if (!refTokens.length) return false;
  return !refTokens.some((t) => newTokens.has(t));
}

/**
 * Upgrade a review file's primary URL when an aggregator provides a better one.
 * Only replaces when existing content is bad (truncated/stub/excerpt/missing).
 * Returns true if the URL was upgraded (caller should mark file as changed).
 *
 * @param {object} [opts]
 * @param {string} [opts.showTitle] - Title of the review's show. When supplied,
 *   the candidate URL must share a distinctive token with it (or with the
 *   existing URL slug) or the upgrade is refused — this blocks combined-roundup
 *   cross-show swaps (the 2026-06-04 War Horse → Equus contamination).
 */
function maybeUpgradeUrl(existingData, newUrl, source, opts = {}) {
  if (!newUrl || existingData.url === newUrl) return false;
  // Reject invalid replacement URLs (relative paths, profile pages)
  if (!newUrl.startsWith('http://') && !newUrl.startsWith('https://')) return false;
  if (isProfileUrl(newUrl)) return false;
  // Only upgrade if current content is bad
  const badContent = !existingData.fullText
    || (existingData.contentTier && existingData.contentTier !== 'complete')
    || existingData.needsRefetch;
  if (!badContent) return false;

  // Cross-show guard: never replace a URL with one that points at a DIFFERENT
  // show. A combined theatre.reviews roundup (War Horse + Equus) supplied an
  // Equus URL as an "upgrade" for a WhatsOnStage War Horse review whose real URL
  // had a bad (cookie-walled) scrape, silently swapping war-horse → equus.
  if (slugLooksLikeDifferentShow(newUrl, { showTitle: opts.showTitle, refUrl: existingData.url })) {
    return false; // candidate URL is about a different show — refuse the swap
  }

  existingData.urlCorrectedFrom = existingData.url;
  existingData.urlCorrectedReason = `Replaced with ${source} URL — original had bad/missing content`;
  existingData.url = newUrl;
  existingData.fullText = null;
  existingData.textStatus = null;
  existingData.contentTier = null;
  existingData.needsRefetch = true;
  return true;
}

module.exports = {
  normalizeOutlet,
  normalizeOutletFull,
  isRegisteredOutlet,
  isJunkOutlet,
  normalizeCritic,
  normalizePublishDate,
  normalizeUrl,
  generateReviewFilename,
  generateReviewKey,
  slugify,
  areReviewsDuplicates,
  areCriticsSimilar,
  areOutletsSame,
  mergeReviews,
  getOutletDisplayName,
  getOutletFromRegistry,
  getOutletTier,
  loadOutletRegistry,
  levenshteinDistance,
  findExistingReviewFile,
  maybeUpgradeUrl,
  slugLooksLikeDifferentShow,
  validateCriticOutlet,
  loadCriticRegistry,
  resolveOutletFromCritic,
  clearCriticRegistryCache,
  resolveOutletFromUrl,
  outletOwnsUrlDomain,
  isCrossOutletUrl,
  WIRE_SERVICE_OUTLETS,
  clearDomainCache,
  getOutletAliases,
  isProfileUrl,
  isSuspiciousOutletId,
  CRITIC_ALIASES,
  AGGREGATOR_SCORE_SOURCES,
};

// OUTLET_ALIASES as a lazy getter — auto-generates from registry on first access
Object.defineProperty(module.exports, 'OUTLET_ALIASES', {
  get: getOutletAliases,
  enumerable: true,
  configurable: true,
});
