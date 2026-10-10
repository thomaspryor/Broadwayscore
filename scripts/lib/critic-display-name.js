'use strict';

/**
 * critic-display-name.js — the ONE place a stored criticName becomes the
 * critic string the site (and the mobile JSON) shows. Audit S7-T1 (BRO-4204).
 *
 * WHY: 11% of 2026 reviews carried critic "Unknown", and placeholders such as
 * "The Stage", "All That Dazzles", "Archive", "The Reviews Hub - London",
 * "Conde Nast", "Written by", "Reviewed by" were emitted as critics — each
 * one got a critic page. Only the exact string "Unknown" was filtered at
 * emission; placeholder detection lived in placeholder-byline.js but was
 * never wired into the build; and four separate typo maps
 * (review-normalization CRITIC_ALIASES, data/auto-critic-aliases.json,
 * critic-canonicalization.js, src/lib/data-reviews.ts CRITIC_NAME_FIXES)
 * disagreed. This helper reads all of them through one function and owns no
 * map of its own except the merged placeholder list below.
 *
 *   displayCriticName(raw, outlet, registryEntry) → string | null
 *
 * Rule order:
 *   1. canonicalizeCritic(outletId, raw) — the outlet-scoped mis-attribution
 *      map (critic-canonicalization.js); outletId comes from registryEntry.id
 *      or normalizeOutlet(outlet).
 *   2. alias table — scripts/lib/critic-name-fixes.json (the 37 display-case
 *      pairs that used to live in src/lib/data-reviews.ts; the TS side now
 *      imports the same JSON) → CRITIC_ALIASES with data/auto-critic-aliases.json
 *      merged in at load (review-normalization.js). A raw string that
 *      slugifies to a canonical keeps its own spelling ("José Solís" stays);
 *      a typo variant gets the canonical's display form.
 *   3. merged placeholder list — JUNK_BYLINES ∪ GENERIC_BYLINE_TERMS ∪
 *      archive / uncredited / condé nast / written by / reviewed by / staff ∪
 *      the registered outlets' own names (display name, id, and the aliases
 *      that read as an outlet, with "team"/"staff"/"desk"/region words peeled
 *      off the edges) → null.
 *   4. anything else that is not a person → null: URL-shaped captures that
 *      yield no name, numbers, a byline label with a one-word remainder
 *      ("Written by Ziwen"), desk/team phrases, an outlet edition label
 *      ("The Reviews Hub - London").
 *   5. suffix stripping LAST — job titles, pronouns, HTML residue — via the
 *      same stripBylineSuffixes() S7-T4 runs at capture time (plus the
 *      ALL-CAPS → title-case rule normalizeBylineCapture applies at capture).
 *      The alias and placeholder lookups key on the stripped form too, so a
 *      trailing ", Chief Theatre Critic" can neither hide a typo nor smuggle
 *      a placeholder through.
 *
 * Two things are never placeholders, whatever rule 3 would say:
 *   - a curated critic (a CRITIC_ALIASES canonical or a fixes-table value).
 *     outlet-registry.json carries critic names as outlet ALIASES for legacy
 *     "outlet-critic" routing ("jesse-green" under nytimes, "adam-feldman"
 *     under timeout, "chris-jones" under chicagotribune) — those are people.
 *   - the outlet's registry-confirmed byline: defaultCritic, or an outlet
 *     that IS its one critic ("Carole Di Tosti", "Matt Trueman"), exactly as
 *     isPlaceholderByline() documents for card #1907.
 *
 * S7-T2 wires this into the reviews.json emission and drops the consumers'
 * private maps; nothing here changes a call site.
 */

const {
  normalizeCritic,
  normalizeOutlet,
  slugify,
  loadOutletRegistry,
  loadCriticRegistry,
  CRITIC_ALIASES,
  JUNK_BYLINES,
  CRITIC_JUNK_PREFIX_RE,
} = require('./review-normalization');
const { canonicalizeCritic } = require('./critic-canonicalization');
const { GENERIC_BYLINE_TERMS, normalizeForCompare } = require('./placeholder-byline');
const { stripBylineSuffixes, normalizeCriticName, looksLikeUrlCriticName } = require('./byline-normalization');
const { decodeHtmlEntities } = require('./text-cleaning');
const { foldDiacritics } = require('./title-match');
const { isOutletishName, isPersonShapedName, CORPORATE_RE } = require('./outlet-name-shape');

const CRITIC_NAME_FIXES = require('./critic-name-fixes.json').fixes;

// Placeholders the 2026 audit found emitted as critics, plus the obvious
// neighbours of each. Lowercase; normalized through normalizeForCompare below
// so punctuation/diacritics ("Condé Nast", "ri-admin") never matter.
const EXTRA_PLACEHOLDERS = [
  'archive', 'archives', 'uncredited', 'conde nast', 'written by', 'reviewed by',
  'review by', 'posted by', 'words by', 'text by', 'story by', 'article by',
  'staff', 'staff critic', 'staff critics', 'staff reviewer', 'staff reviewers',
  'guest critic', 'guest reviewer', 'guest writer', 'reviewer', 'reviewers',
  'reviews', 'review', 'editorial', 'the editor', 'the editors', 'editorial board',
  'web desk', 'digital desk', 'arts desk', 'culture desk', 'features desk',
  'news', 'news team', 'features', 'press', 'press office', 'press release', 'pr',
  'sponsored', 'sponsored content', 'advertorial', 'partner content',
  'author', 'writer', 'columnist', 'blogger', 'user', 'member', 'moderator',
  'webmaster', 'site admin', 'no byline', 'no author', 'unknown author',
  'unknown critic', 'not available', 'n a', 'na', 'tbc', 'tbd', 'various',
  'multiple', 'multiple authors', 'various authors', 'team', 'the team',
  'editorial team', 'review team', 'reviews team', 'social team', 'web team',
  'digital team', 'content team', 'anon', 'anonymous', 'critic', 'critics',
  'the critic', 'the critics', 'theatre', 'theater', 'theatre desk',
  'theater desk', 'default', 'null', 'none', 'unknown', 'unavailable',
];

const PLACEHOLDER_BYLINES = new Set(
  [...JUNK_BYLINES, ...GENERIC_BYLINE_TERMS, ...EXTRA_PLACEHOLDERS]
    .map(normalizeForCompare)
    .filter(Boolean)
);

// "Written by Ziwen" — the byline extractor kept the label. A one-word
// remainder cannot be verified as a person (admin-ingest's
// isPlausibleCriticName needs 2+ words too) → null; a 2+ word remainder is
// the name with the label removed.
const BYLINE_LABEL_RE = /^(?:(?:written|reviewed|review|posted|words|text|story|article|photos?|photography|reporting|reported|edited|compiled)\s+by|by)\b[:\s]*/i;

// Desk / team phrases anywhere in the string are never a person
// ("London Theatre Hub Editorial Team").
const DESK_PHRASE_RE = /\b(?:editorial (?:team|staff|board|desk)|news ?desk|(?:review|reviews|social|web|digital|arts|culture|features|content|theatre|theater|news) (?:team|desk|staff))\b/;

// Generic words peeled off either edge before the outlet-name comparison, so
// "Team BWW", "BWW Staff", "Guardian Stage", "The Reviews Hub London" all
// reduce to the outlet.
const EDGE_GENERIC = new Set([
  'team', 'staff', 'editor', 'editors', 'editorial', 'desk', 'reviews', 'review',
  'critic', 'critics', 'reviewer', 'reviewers', 'writer', 'writers', 'the',
  'contributor', 'contributors', 'uk', 'us', 'usa', 'london', 'ny', 'nyc',
  'edition', 'online', 'digital', 'web', 'stage', 'arts', 'culture', 'theatre',
  'theater', 'news', 'features', 'entertainment', 'lifestyle', 'section',
]);
const EDGE_GENERIC_PAIRS = new Set(['new york', 'west end', 'north west', 'north east', 'south west', 'south east']);

// Segment separator for "Outlet - Edition" / "Name — Outlet" strings.
const ATTRIBUTION_SEP_RE = /\s+(?:[-–—|:]|\/)\s+/;

let _outletNameSet = null;
let _fixesByKey = null;
let _fixesBySlug = null;
let _criticRegistryNames = null;

function stripLeadingThe(s) {
  return s.replace(/^the\s+/, '');
}

function normKey(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fixesByKey() {
  if (_fixesByKey) return _fixesByKey;
  _fixesByKey = new Map();
  for (const [k, v] of Object.entries(CRITIC_NAME_FIXES)) _fixesByKey.set(normKey(k), v);
  return _fixesByKey;
}

function fixesBySlug() {
  if (_fixesBySlug) return _fixesBySlug;
  _fixesBySlug = new Map();
  for (const v of Object.values(CRITIC_NAME_FIXES)) _fixesBySlug.set(slugify(v), v);
  return _fixesBySlug;
}

/** True when the string is a curated critic: a CRITIC_ALIASES canonical/alias or a fixes-table spelling. */
function isCuratedCritic(name) {
  const key = normalizeForCompare(name);
  if (!key) return false;
  if (fixesBySlug().has(slugify(name)) || fixesBySlug().has(key.replace(/ /g, '-'))) return true;
  const slug = normalizeCritic(name);
  return slug !== 'unknown' && Object.prototype.hasOwnProperty.call(CRITIC_ALIASES, slug);
}

/** True when a normalized string reads as an outlet name rather than a person (shared vocabulary: outlet-name-shape.js). */
function isOutletish(key) {
  return isOutletishName(key);
}

function ownNamesOf(id, entry) {
  return new Set(
    [entry && entry.displayName, id, ...((entry && Array.isArray(entry.aliases)) ? entry.aliases : [])]
      .map(normalizeForCompare)
      .filter(Boolean)
  );
}

/**
 * This outlet IS its one critic: defaultCritic is the outlet's own name
 * ("Carole Di Tosti"), the outlet is a curated critic ("Matt Trueman"), or
 * the display name simply reads as a person ("Jonathan Baz" — a solo blog
 * named after its author, no defaultCritic set).
 */
function isSelfBrandedOutlet(id, entry) {
  if (!entry) return false;
  const own = ownNamesOf(id, entry);
  const dc = normalizeForCompare(entry.defaultCritic);
  if (dc && (own.has(dc) || own.has(stripLeadingThe(dc)) || [...own].some((n) => stripLeadingThe(n) === dc))) return true;
  if (typeof entry.displayName !== 'string') return false;
  if (isCuratedCritic(entry.displayName)) return true;
  return isPersonShapedName(normalizeForCompare(entry.displayName));
}

/** critic-registry.json display names (real bylines, longest form seen), keyed by punctuation-insensitive name. Optional file. */
function criticRegistryNames() {
  if (_criticRegistryNames) return _criticRegistryNames;
  _criticRegistryNames = new Map();
  let registry = null;
  try { registry = loadCriticRegistry(); } catch (e) { registry = null; }
  const critics = (registry && registry.critics) || {};
  for (const c of Object.values(critics)) {
    if (!c || typeof c.displayName !== 'string') continue;
    const clean = stripBylineSuffixes(c.displayName).trim();
    const key = normKey(clean);
    if (key && !_criticRegistryNames.has(key)) _criticRegistryNames.set(key, clean);
  }
  return _criticRegistryNames;
}

/** Every registered outlet's own names that read as an outlet, minus curated critics and registry bylines. */
function outletNameSet() {
  if (_outletNameSet) return _outletNameSet;
  const names = new Set();
  let registry = null;
  try { registry = loadOutletRegistry(); } catch (e) { registry = null; }
  const outlets = (registry && registry.outlets) || {};
  const defaultCritics = new Set();
  for (const o of Object.values(outlets)) {
    if (o && typeof o.defaultCritic === 'string') {
      const dc = normalizeForCompare(o.defaultCritic);
      if (dc) defaultCritics.add(dc);
    }
  }
  const selfBrandedIds = new Set();
  const add = (n) => {
    if (!n || n.length < 2 || defaultCritics.has(n)) return;
    names.add(n);
    names.add(stripLeadingThe(n));
  };
  for (const [id, o] of Object.entries(outlets)) {
    if (!o || typeof o !== 'object') continue;
    if (isSelfBrandedOutlet(id, o)) { selfBrandedIds.add(id); continue; }
    // Display name and id are outlet names by definition.
    for (const n of [o.displayName, id].map(normalizeForCompare)) add(n);
    // Aliases only when they read as an outlet (see OUTLET_WORDS).
    for (const a of Array.isArray(o.aliases) ? o.aliases : []) {
      const n = normalizeForCompare(a);
      if (n && isOutletish(n) && !isCuratedCritic(a)) add(n);
    }
  }
  const aliasIndex = (registry && registry._aliasIndex) || {};
  for (const [alias, id] of Object.entries(aliasIndex)) {
    if (selfBrandedIds.has(id)) continue;
    const n = normalizeForCompare(alias);
    if (n && isOutletish(n) && !isCuratedCritic(alias)) add(n);
  }
  names.delete('');
  _outletNameSet = names;
  return _outletNameSet;
}

const LOWER_PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ter', 'of', 'the', 'and', 'y', 'e', 'bin', 'ibn', 'al', 'el']);

function capWord(p) {
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : p;
}

function capPart(p) {
  if (!p) return p;
  if (/^[a-z]\.(?:[a-z]\.)*$/i.test(p)) return p.toUpperCase();      // a.d. → A.D.
  if (/^[bcdfghjklmnpqrstvwxz]{2}$/i.test(p)) return p.toUpperCase(); // jd → JD
  if (/^mc[a-z]/i.test(p)) return 'Mc' + capWord(p.slice(2));       // mcnulty → McNulty
  if (/^[od]'[a-z]/i.test(p)) return p.charAt(0).toUpperCase() + "'" + capWord(p.slice(2)); // o'brien → O'Brien
  return capWord(p);
}

/** Title-case a lowercase alias-table spelling ("chales mcnulty" → "Chales McNulty"). */
function titleCaseName(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && LOWER_PARTICLES.has(lw)) return lw;
      return lw.split('-').map(capPart).join('-');
    })
    .join(' ');
}

/**
 * Display form for a CRITIC_ALIASES canonical slug, used only when the raw
 * string was a typo variant: the shared fixes table's spelling, else the
 * registry defaultCritic when it is this critic, else the critic registry's
 * real byline when it is the same name modulo punctuation ("holly omahony"
 * → "Holly O'Mahony"), else the alias whose slug is the canonical (by
 * convention the first entry), title-cased.
 */
function displayFormForCanonical(slug, registryEntry) {
  const fromFixes = fixesBySlug().get(slug);
  if (fromFixes) return fromFixes;
  const dc = registryEntry && typeof registryEntry.defaultCritic === 'string' ? registryEntry.defaultCritic.trim() : '';
  if (dc && slugify(dc) === slug) return dc;
  const aliases = CRITIC_ALIASES[slug] || [];
  const spelled = aliases.find((a) => slugify(a) === slug) || slug.replace(/-/g, ' ');
  const fromRegistry = criticRegistryNames().get(normKey(spelled));
  if (fromRegistry) return fromRegistry;
  return titleCaseName(spelled);
}

function preclean(raw) {
  return decodeHtmlEntities(String(raw))
    .replace(/<\/?[a-z][^<>]*\/?>/gi, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(CRITIC_JUNK_PREFIX_RE, '')
    .trim();
}

/** Resolve {id, entry} for this review's outlet from the argument pair (registryEntry wins; else the registry by outlet name). */
function resolveOutlet(outlet, registryEntry) {
  let id = null;
  if (registryEntry && typeof registryEntry.id === 'string' && registryEntry.id) id = registryEntry.id;
  else if (registryEntry && typeof registryEntry.outletId === 'string' && registryEntry.outletId) id = registryEntry.outletId;
  else if (typeof outlet === 'string' && outlet.trim()) {
    const n = normalizeOutlet(outlet);
    if (n && n !== 'unknown') id = n;
  }
  let entry = registryEntry && typeof registryEntry === 'object' ? registryEntry : null;
  if (!entry && id) {
    try {
      const registry = loadOutletRegistry();
      entry = (registry && registry.outlets && registry.outlets[id]) || null;
    } catch (e) { entry = null; }
  }
  return { id, entry };
}

/** All the forms a string takes with generic words peeled off either edge, the full string first. */
function edgeVariants(key) {
  const tokens = String(key || '').split(' ').filter(Boolean);
  const out = [];
  const seen = new Set();
  const stack = [[0, tokens.length]];
  while (stack.length) {
    const [s, e] = stack.shift();
    const id = s + ':' + e;
    if (seen.has(id) || s >= e) continue;
    seen.add(id);
    out.push(tokens.slice(s, e).join(' '));
    if (EDGE_GENERIC.has(tokens[s])) stack.push([s + 1, e]);
    if (e - s >= 2 && EDGE_GENERIC_PAIRS.has(tokens[s] + ' ' + tokens[s + 1])) stack.push([s + 2, e]);
    if (EDGE_GENERIC.has(tokens[e - 1])) stack.push([s, e - 1]);
    if (e - s >= 2 && EDGE_GENERIC_PAIRS.has(tokens[e - 2] + ' ' + tokens[e - 1])) stack.push([s, e - 2]);
  }
  return out;
}

/** True when every token is a generic edge word ("editorial team", "the staff"). */
function isAllGeneric(key) {
  const tokens = String(key || '').split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => EDGE_GENERIC.has(t));
}

/**
 * True when the (normalized) string, or the string with generic edge words
 * peeled off, is a registered outlet's name — or this review's own outlet's
 * name, unless the registry says that outlet is its one critic.
 */
function matchesOutletName(key, ctx) {
  if (!key) return false;
  const global = outletNameSet();
  const own = new Set();
  if (typeof ctx.outlet === 'string') {
    const n = normalizeForCompare(ctx.outlet);
    if (n) { own.add(n); own.add(stripLeadingThe(n)); }
  }
  if (ctx.entry && !isSelfBrandedOutlet(ctx.id, ctx.entry)) {
    for (const n of ownNamesOf(ctx.id, ctx.entry)) { own.add(n); own.add(stripLeadingThe(n)); }
  } else if (ctx.entry) {
    own.clear(); // self-branded outlet: its own name is the critic
  }
  for (const v of edgeVariants(key)) {
    const forms = [v, stripLeadingThe(v)];
    for (const f of forms) {
      if (!f) continue;
      if (global.has(f)) return true;
      if (own.has(f) && isOutletish(f)) return true;
    }
  }
  return false;
}

function isPlaceholderPhrase(key) {
  if (!key) return true;
  if (PLACEHOLDER_BYLINES.has(key)) return true;
  if (DESK_PHRASE_RE.test(key)) return true;
  if (CORPORATE_RE.test(key)) return true; // "PLASA Media Inc"
  const label = key.match(BYLINE_LABEL_RE);
  if (label) {
    const rest = key.slice(label[0].length).trim();
    if (!rest || rest.split(' ').length < 2) return true;
  }
  return false;
}

/**
 * "Outlet - Edition" is a placeholder; "Name — Outlet" is the name.
 * Returns { placeholder: true } or { name } (possibly shortened).
 */
function splitAttribution(name, ctx) {
  const parts = name.split(ATTRIBUTION_SEP_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { name };
  const first = normalizeForCompare(parts[0]);
  if (!isCuratedCritic(parts[0]) && (isPlaceholderPhrase(first) || matchesOutletName(first, ctx))) {
    return { placeholder: true };
  }
  const last = normalizeForCompare(parts[parts.length - 1]);
  if (!isCuratedCritic(parts[parts.length - 1]) && matchesOutletName(last, ctx)) {
    return { name: parts.slice(0, -1).join(' ') };
  }
  return { name };
}

/** The registry's own claim for who writes at this outlet, unless that claim is itself a placeholder. */
function registryDefaultCriticKey(ctx) {
  const dc = ctx.entry && typeof ctx.entry.defaultCritic === 'string' ? ctx.entry.defaultCritic : '';
  if (!dc) return '';
  const key = normalizeForCompare(dc);
  if (!key || isPlaceholderPhrase(key)) return '';
  const parts = dc.split(ATTRIBUTION_SEP_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && matchesOutletName(normalizeForCompare(parts[0]), { outlet: null, entry: null, id: null })) return ''; // "Outlet - Edition"
  return key;
}

/**
 * True when the (already cleaned) name is not a person: a placeholder term,
 * a desk phrase, a byline label, an outlet's own name, a number.
 */
function isNonPerson(name, ctx) {
  const key = normalizeForCompare(name);
  if (!key || key.length < 2) return true;
  if (/^\d+$/.test(key.replace(/\s+/g, ''))) return true;
  if (!/[a-z]/.test(key)) return true;
  const dcKey = registryDefaultCriticKey(ctx);
  if (dcKey && dcKey === key) return false;
  if (isPlaceholderPhrase(key)) return true;
  if (isAllGeneric(key)) return true;
  if (isCuratedCritic(name)) return false;
  if (matchesOutletName(key, ctx)) return true;
  return false;
}

/**
 * The critic string to display for a stored criticName, or null when the
 * byline is not a person. See the header for the rule order.
 *
 * @param {*} raw - stored criticName (reviews.json / review-texts record)
 * @param {string} [outlet] - outlet display name or id for this review
 * @param {{id?: string, displayName?: string, aliases?: string[], defaultCritic?: string|null}} [registryEntry]
 *   data/outlet-registry.json outlets[outletId] for this review's outlet; looked
 *   up from `outlet` when omitted
 * @returns {string|null}
 */
function displayCriticName(raw, outlet, registryEntry) {
  if (typeof raw !== 'string') return null;
  // The shared fixes table is keyed by the EXACT stored string ("CSA.     Naveen
  // Kumar", "Daniel D&#8217;Addario"), so consult it before any cleanup.
  const exactFix = CRITIC_NAME_FIXES[raw] || CRITIC_NAME_FIXES[raw.trim()];
  let name = exactFix || preclean(raw);
  if (!name) return null;

  // A byline-link href stored as the name: recover the person or give up.
  if (looksLikeUrlCriticName(name)) {
    name = normalizeCriticName(name);
    if (!name) return null;
  }

  const ctx = { outlet: typeof outlet === 'string' ? outlet : null, ...resolveOutlet(outlet, registryEntry) };

  // 1. outlet-scoped mis-attribution map
  if (ctx.id) name = canonicalizeCritic(ctx.id, name).name;

  // "Written by Jane Doe" → "Jane Doe"; "Written by Ziwen" → null (rule 4).
  const labelMatch = name.match(BYLINE_LABEL_RE);
  if (labelMatch) {
    const rest = name.slice(labelMatch[0].length).trim();
    if (!rest || rest.split(/\s+/).length < 2) return null;
    name = rest;
  }

  // "The Reviews Hub - London" → null; "Jane Doe — The Stage" → "Jane Doe".
  const seg = splitAttribution(name, ctx);
  if (seg.placeholder) return null;
  name = seg.name;

  // Lookups key on the suffix-stripped form (rule 5 applies to the output).
  const stripped = stripBylineSuffixes(name);
  if (!stripped) return null;

  // 2. alias table
  const fixed = CRITIC_NAME_FIXES[stripped] || fixesByKey().get(normKey(stripped));
  if (fixed) {
    name = fixed;
  } else {
    const slug = normalizeCritic(stripped);
    if (slug === 'unknown') return null;
    if (Object.prototype.hasOwnProperty.call(CRITIC_ALIASES, slug) && slugify(stripped) !== slug) {
      name = displayFormForCanonical(slug, ctx.entry);
    } else {
      name = stripped;
    }
  }

  // 3 + 4. placeholders and everything else that is not a person
  if (isNonPerson(name, ctx)) return null;

  // 5. suffix stripping last (idempotent; guards a fixes/alias value too),
  //    plus the capture-time ALL-CAPS rule so "ELYSA GARDNER" and "Elysa
  //    Gardner" are one critic.
  let out = stripBylineSuffixes(name).trim();
  if (out && /^[A-Z][A-Z\s.'’-]+$/.test(out) && /[A-Z]{2}/.test(out.replace(/[^A-Z]/g, ''))) out = titleCaseName(out);
  return out || null;
}

/** True when displayCriticName() would drop this byline. */
function isPlaceholderCritic(raw, outlet, registryEntry) {
  return displayCriticName(raw, outlet, registryEntry) === null;
}

/** Test hook: forget the cached registry-derived sets. */
function _resetCaches() {
  _outletNameSet = null;
  _fixesByKey = null;
  _fixesBySlug = null;
  _criticRegistryNames = null;
}

module.exports = {
  displayCriticName,
  isPlaceholderCritic,
  // Exposed for tests + S7-T2 consumers.
  PLACEHOLDER_BYLINES,
  CRITIC_NAME_FIXES,
  titleCaseName,
  displayFormForCanonical,
  edgeVariants,
  isCuratedCritic,
  outletNameSet,
  _resetCaches,
};
