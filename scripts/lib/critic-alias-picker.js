'use strict';

/**
 * critic-alias-picker.js — the canonical-vs-typo decision for a distance-1
 * critic-slug pair, extracted from scripts/detect-critic-typos.js so the rule
 * is testable with a fixture (CLAUDE.md §15). Audit S7-T5 (BRO-4204).
 *
 * WHY: the weekly picker chose "whichever slug has more files" and then wrote
 * that slug as a NEW key of data/auto-critic-aliases.json — even when the
 * slug was already an alias of another canonical. Over time the file grew 15
 * alias strings claimed by two canonicals ("sara hemming" under both
 * sarah-hemming and sara-hemming) and 9 canonical keys that are themselves
 * typos aliased elsewhere (alesis-soloski, nicholas-dejongh, bill-hageity…).
 * review-normalization.js merges the file into CRITIC_ALIASES at load, so a
 * conflicting alias resolves to whichever entry iterates first — the typo
 * spelling could win and mint its own critic page.
 *
 * Rules, in order:
 *   1. a pair that differs only in a digit is never a typo (year/edition
 *      suffixes such as helen-shaw-2024-bway / -2025-bway) → skip
 *   2. a candidate that is already in the alias table (as a canonical OR as an
 *      alias of another canonical) resolves to ITS canonical — the picker
 *      never writes a canonical that is an alias elsewhere; both known and
 *      resolving to different critics → skip (a human decides)
 *   3. prefer the registry spelling: a slug present in data/outlet-registry.json
 *      defaultCritic values or in data/critic-registry.json
 *   4. otherwise the slug with more files (ties → the first argument, which
 *      the caller passes in sorted order)
 */

const { slugify } = require('./review-normalization');
const { foldDiacritics } = require('./title-match');
const { isPersonShapedName } = require('./outlet-name-shape');

/** The alias-string → slug form detect-critic-typos.js has always used. */
function aliasSlug(alias) {
  return String(alias || '').trim().replace(/\s+/g, '-').replace(/\./g, '');
}

/** Follow alias → canonical links to a root; null on a cycle. */
function followChain(slug, idx) {
  let cur = slug;
  const seen = new Set();
  while (idx.has(cur) && idx.get(cur) !== cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = idx.get(cur);
  }
  return cur;
}

/**
 * Build the reverse index of an aliases table ({canonical: [alias, ...]}).
 * Aliases override a key's self-mapping, so a canonical key that is ALSO an
 * alias of another canonical resolves to that other canonical, and every
 * alias points straight at its resolved root. An alias claimed by canonicals
 * that resolve to DIFFERENT roots lands in `conflicts` (an alias shared by a
 * key and the key's own alias-home is not a conflict — both roads lead to
 * the same critic).
 *
 * @returns {{ idx: Map<string,string>, conflicts: Map<string, Set<string>> }}
 */
function buildAliasIndex(criticAliases) {
  const table = criticAliases || {};
  const claims = new Map(); // alias slug → Set(canonical keys that list it)
  for (const [canonical, aliases] of Object.entries(table)) {
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      const s = aliasSlug(alias);
      if (!s || s === canonical) continue;
      if (!claims.has(s)) claims.set(s, new Set());
      claims.get(s).add(canonical);
    }
  }
  const idx = new Map();
  for (const key of Object.keys(table)) idx.set(key, key);
  for (const [s, canons] of claims) idx.set(s, [...canons][0]); // a claimed key is an alias, not a root
  const conflicts = new Map();
  for (const [s, canons] of claims) {
    const roots = new Set();
    for (const c of canons) {
      const root = followChain(c, idx);
      roots.add(root === null ? `<cycle:${c}>` : root);
    }
    if (roots.size > 1) conflicts.set(s, canons);
    else idx.set(s, [...roots][0]);
  }
  return { idx, conflicts };
}

/**
 * Resolve a slug through the alias index (following alias-of-alias chains).
 * @returns {{ known: boolean, canonical: string|null, ambiguous: boolean }}
 */
function resolveCanonical(slug, aliasIndex) {
  const { idx, conflicts } = aliasIndex;
  if (conflicts.has(slug)) return { known: true, canonical: null, ambiguous: true };
  if (!idx.has(slug)) return { known: false, canonical: null, ambiguous: false };
  const root = followChain(slug, idx);
  if (root === null || conflicts.has(root) || root.startsWith('<cycle:')) {
    return { known: true, canonical: null, ambiguous: true };
  }
  return { known: true, canonical: root, ambiguous: false };
}

/** True when the two slugs differ only in digits ("...-2024-bway" vs "...-2025-bway"). */
function digitsOnlyDifference(a, b) {
  return a !== b && /\d/.test(a + b) && a.replace(/\d/g, '') === b.replace(/\d/g, '');
}

/**
 * Registry spellings: every outlet-registry defaultCritic (slugified) plus
 * every key of the critic registry, when either is provided.
 */
function buildRegistrySpellings({ outletRegistry, criticRegistry } = {}) {
  const set = new Set();
  const outlets = (outletRegistry && outletRegistry.outlets) || {};
  for (const o of Object.values(outlets)) {
    if (o && typeof o.defaultCritic === 'string') {
      const s = slugify(o.defaultCritic);
      if (s) set.add(s);
    }
  }
  const critics = (criticRegistry && criticRegistry.critics) || {};
  for (const k of Object.keys(critics)) if (k) set.add(k);
  return set;
}

/**
 * Outlet names as critic slugs: every outlet's id and display name (slugified
 * two ways, with and without a leading "the-"). "the-stage" / "thestage" once
 * became a critic alias pair because both existed as byline slugs at the same
 * outlet; an outlet name is never a critic, so the picker refuses such a pair.
 * Aliases are deliberately NOT included — the registry carries critic names
 * as outlet aliases for legacy routing ("mark-kennedy" under ap) — and a
 * person-named outlet's display name ("Matt Trueman", "Jonathan Baz") is
 * that person, so only its id is listed.
 */
function buildOutletSlugs(outletRegistry) {
  const set = new Set();
  const outlets = (outletRegistry && outletRegistry.outlets) || {};
  const add = (s) => {
    if (!s) return;
    set.add(s);
    if (s.startsWith('the-')) set.add(s.slice(4));
    else set.add('the-' + s);
  };
  for (const [id, o] of Object.entries(outlets)) {
    add(id);
    if (o && typeof o.displayName === 'string') {
      const spaced = foldDiacritics(o.displayName).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
      if (isPersonShapedName(spaced)) continue;
      add(slugify(o.displayName));
      add(spaced.replace(/ /g, '-'));
    }
  }
  set.delete('');
  return set;
}

/**
 * Decide which of a distance-1 slug pair is canonical.
 *
 * @param {object} p
 * @param {string} p.a - first slug (callers pass the sorted-first slug)
 * @param {string} p.b - second slug
 * @param {number} p.countA - review files under slug a
 * @param {number} p.countB - review files under slug b
 * @param {{idx: Map, conflicts: Map}} p.aliasIndex - from buildAliasIndex(CRITIC_ALIASES)
 * @param {Set<string>} [p.registrySpellings] - from buildRegistrySpellings()
 * @param {Set<string>} [p.outletSlugs] - from buildOutletSlugs()
 * @returns {{ skip: true, silent?: boolean, reason: string }
 *          | { skip: false, canonical: string, typo: string, reason: string }}
 */
function pickCanonical({ a, b, countA = 0, countB = 0, aliasIndex, registrySpellings = new Set(), outletSlugs = new Set() }) {
  if (!a || !b || a === b) return { skip: true, reason: 'not a pair' };
  if (digitsOnlyDifference(a, b)) {
    return { skip: true, reason: 'differs only in a digit (year/edition suffix), not a typo' };
  }
  const index = aliasIndex || buildAliasIndex({});
  const ra = resolveCanonical(a, index);
  const rb = resolveCanonical(b, index);
  if (ra.ambiguous || rb.ambiguous) {
    return { skip: true, reason: 'a candidate is an alias claimed by two canonicals in the alias table; resolve by hand' };
  }
  if (ra.known && rb.known) {
    if (ra.canonical === rb.canonical) return { skip: true, silent: true, reason: 'already aliased together' };
    return { skip: true, reason: `both already in the alias table under different canonicals (${ra.canonical} vs ${rb.canonical})` };
  }
  if (outletSlugs.has(a) || outletSlugs.has(b)) {
    return { skip: true, reason: `${outletSlugs.has(a) ? a : b} is an outlet name, not a critic` };
  }
  if (ra.known) {
    return { skip: false, canonical: ra.canonical, typo: b, reason: ra.canonical === a ? `${a} is an existing canonical` : `${a} is an alias of ${ra.canonical}` };
  }
  if (rb.known) {
    return { skip: false, canonical: rb.canonical, typo: a, reason: rb.canonical === b ? `${b} is an existing canonical` : `${b} is an alias of ${rb.canonical}` };
  }
  const inA = registrySpellings.has(a);
  const inB = registrySpellings.has(b);
  if (inA !== inB) {
    return inA
      ? { skip: false, canonical: a, typo: b, reason: `${a} is the registry spelling` }
      : { skip: false, canonical: b, typo: a, reason: `${b} is the registry spelling` };
  }
  return countA >= countB
    ? { skip: false, canonical: a, typo: b, reason: `${a} has more files (${countA} vs ${countB})` }
    : { skip: false, canonical: b, typo: a, reason: `${b} has more files (${countB} vs ${countA})` };
}

/** The key of `aliases` whose list carries `slug` as an alias, if any (other than `slug` itself). */
function findAliasHome(aliases, slug) {
  const spaced = slug.replace(/-/g, ' ');
  for (const [key, list] of Object.entries(aliases || {})) {
    if (key === slug || !Array.isArray(list)) continue;
    if (list.includes(spaced) || list.includes(slug)) return key;
  }
  return null;
}

/**
 * Record typo → canonical in an auto-aliases table IN PLACE, never creating a
 * key that is an alias of another key (the alias' home key is used instead)
 * and never adding a typo string that another key already claims.
 *
 * @returns {{ added: boolean, target: string|null, reason?: string }}
 */
function recordAlias(aliases, canonical, typo) {
  const home = findAliasHome(aliases, canonical);
  const target = home || canonical;
  const typoSpaced = typo.replace(/-/g, ' ');
  const typoHome = findAliasHome(aliases, typo);
  if (typoHome && typoHome !== target) {
    return { added: false, target: null, reason: `${typo} is already an alias of ${typoHome}` };
  }
  if (aliases[typo] && typo !== target) {
    return { added: false, target: null, reason: `${typo} is itself a canonical key; merge by hand` };
  }
  if (!aliases[target]) aliases[target] = [target.replace(/-/g, ' ')];
  if (aliases[target].includes(typoSpaced)) return { added: false, target, reason: 'already present' };
  aliases[target].push(typoSpaced);
  return { added: true, target };
}

module.exports = {
  aliasSlug,
  buildAliasIndex,
  resolveCanonical,
  digitsOnlyDifference,
  buildRegistrySpellings,
  buildOutletSlugs,
  pickCanonical,
  findAliasHome,
  recordAlias,
};
