/**
 * Near-duplicate outlet-registry detector (the-la-times class, task #1838 / BRO-90;
 * extended to the slugify()/concatenated class by task #1844).
 *
 * buildRegistryAliasMap() (scripts/lib/review-normalization.js) resolves free
 * text to a canonical outlet ID via a WIDER surface than either existing
 * validate-data.js check covers: id, displayName, every alias, AND the
 * "the "/"the-" prefix-stripped form of each of those (normalizeOutlet's
 * withoutThe fallback). A new registry outlet whose id/displayName/aliases
 * land on any of those forms already claimed by a DIFFERENT outlet is a
 * silent semantic duplicate — it looks like a plausible standalone outlet
 * (so isJunkOutlet() never flags it) and its raw text never literally
 * collides with an existing alias entry (so the existing collision checks
 * never flag it either). It only manifests downstream as reviews resolving
 * to the wrong outlet.
 *
 * This is exactly what happened with 'the-la-times' (tier 3): its
 * displayName "The La Times" stripped to "la times", which was already an
 * alias of 'latimes' (tier 1) — silently stealing byline-matched reviews.
 *
 * Task #1844 extends this to normalizeOutlet()'s slugify()-based fallback
 * (review-normalization.js:427-437): a slugified query only equals a
 * DIFFERENT outlet's raw (unslugified) key when that key happens to already
 * be slug-shaped, so slugify() alone doesn't connect a hyphenated id to a
 * concatenated one (slugify('theater-news-online') === 'theater-news-online',
 * it does not become 'theaternewsonline'). What actually creates the
 * duplicate is normalizeOutlet()'s startsWith()-based concatenated-critic
 * matching (lines 399-425) and the fact that an unresolved slug is used
 * verbatim as a brand-new outlet id (line 440) — so a hyphenated masthead
 * ("Theater News Online") and its de-hyphenated form ("theaternewsonline",
 * e.g. from a bare domain) silently register as two separate outlets. Add
 * each key's slugified form AND that slug with hyphens removed so a
 * hyphenated and concatenated registration of the same outlet collide here.
 */

const { isSentinelOutletId, slugify } = require('./review-normalization');

/**
 * Strip a leading "the " (space-separated text) or "the-" (slug/id text)
 * prefix — mirrors normalizeOutlet's two withoutThe/slugWithoutThe forms.
 */
function stripLeadingThe(text) {
  return text.replace(/^the[\s-]+/, '');
}

/**
 * Expand one piece of raw text into every form it would resolve from in
 * buildRegistryAliasMap()'s surface: raw, "the "-stripped, slugified,
 * "the-"-stripped-slug, and concatenated (slug with hyphens removed).
 * Shared by buildOutletTextKeys() (outlet id/displayName/aliases) and the
 * _aliasIndex scan in findOutletAliasCollisions() — both are literal-text
 * resolution sources and must get the same expansion (task #1844: an
 * earlier version only expanded outlet-owned keys, missing a hyphenated
 * vs. concatenated collision between an _aliasIndex entry and an outlet).
 *
 * @param {string} text
 * @returns {string[]} lowercase forms (deduplicated by the caller's Set)
 */
function expandTextKeyForms(text) {
  const forms = [];
  if (!text) return forms;
  const lower = String(text).toLowerCase().trim();
  if (!lower) return forms;
  forms.push(lower);
  const stripped = stripLeadingThe(lower);
  if (stripped && stripped !== lower) forms.push(stripped);

  const slug = slugify(lower);
  if (!slug) return forms;
  forms.push(slug);
  const slugStripped = stripLeadingThe(slug);
  if (slugStripped && slugStripped !== slug) forms.push(slugStripped);
  // Concatenated form (no separators) — connects a hyphenated masthead
  // registration ('theater-news-online') to a bare-domain-style one
  // ('theaternewsonline') for the same real outlet.
  const concat = slug.replace(/-/g, '');
  if (concat && concat !== slug) forms.push(concat);

  return forms;
}

/**
 * Build the same text-key resolution surface buildRegistryAliasMap() builds
 * for a single outlet: its id, displayName, and aliases, each expanded via
 * expandTextKeyForms().
 *
 * @param {string} outletId
 * @param {object} entry - registry.outlets[outletId]
 * @returns {string[]} lowercase text keys this outlet would resolve from
 */
function buildOutletTextKeys(outletId, entry) {
  const keys = new Set();
  const addKey = (text) => {
    for (const form of expandTextKeyForms(text)) keys.add(form);
  };

  addKey(outletId);
  addKey(entry && entry.displayName);
  for (const alias of (entry && entry.aliases) || []) {
    addKey(alias);
  }

  return [...keys];
}

/**
 * Declared exceptions: [textKey, outletIdA, outletIdB] triples where a
 * collision is a deliberate, investigated edition/masthead split rather
 * than a duplicate — same pattern as EDITION_PAIRS / DECLARED_ALIAS_OVERLAPS
 * in scripts/lib/outlet-registry-domain-collisions.js. Add entries here
 * instead of weakening the detector when a legitimate split turns up.
 */
const DECLARED_THE_EXCEPTIONS = [
  // Not an outlet duplicate: 'cote-notices' lists critic David Cote's own
  // name ("david cote") as an alias of his self-published Substack outlet;
  // the unrelated _aliasIndex entry 'david-cote' -> 'observer' is a
  // critic-name routing default (his primary staff outlet), not a second
  // registration of the same site. Collides on both the slugified
  // ('david-cote') and concatenated ('davidcote') forms of "david cote"
  // (task #1844); investigated, not merged. If normalizeOutlet('David
  // Cote')/('DavidCote') ever needs to resolve consistently regardless of
  // separator, that's a routing-precedence fix in review-normalization.js,
  // not a registry merge — these two outlets are genuinely different.
  ['david-cote', 'cote-notices', 'observer'],
  ['davidcote', 'cote-notices', 'observer'],
];

function isDeclaredException(key, outletIds) {
  return DECLARED_THE_EXCEPTIONS.some(
    ([exKey, a, b]) => exKey === key && outletIds.length === 2 && outletIds.includes(a) && outletIds.includes(b)
  );
}

/**
 * Find text keys claimed by 2+ distinct outlet IDs — i.e. outlets whose
 * identity (id/displayName/alias, raw or the-stripped) collides with
 * another outlet's identity, OR with a DIFFERENT outlet's `_aliasIndex`
 * entry, in buildRegistryAliasMap()'s resolution surface. `_aliasIndex` is
 * a second, independent source of raw resolvable text
 * (review-normalization.js:104-111) — a new outlet whose own identity lands
 * on an existing `_aliasIndex` alias is exactly as silent a duplicate as one
 * colliding with another outlet's own `aliases` array.
 *
 * @param {object} outlets - registry.outlets map (id → entry)
 * @param {object} [aliasIndex] - registry._aliasIndex map (alias → canonical outletId)
 * @returns {Array<{key: string, outletIds: string[]}>} collision groups,
 *   sorted by key
 */
function findOutletAliasCollisions(outlets, aliasIndex) {
  const byKey = new Map();
  const claim = (key, outletId) => {
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(outletId);
  };

  for (const [id, entry] of Object.entries(outlets || {})) {
    if (id === '_aliasIndex' || id === '_meta' || !entry) continue;
    if (isSentinelOutletId(id)) continue;

    for (const key of buildOutletTextKeys(id, entry)) {
      claim(key, id);
    }
  }

  for (const [alias, targetId] of Object.entries(aliasIndex || {})) {
    if (alias === '_note' || !targetId) continue;
    for (const form of expandTextKeyForms(alias)) claim(form, targetId);
  }

  const collisions = [];
  for (const [key, ids] of byKey) {
    if (ids.size > 1) {
      const outletIds = [...ids].sort();
      if (isDeclaredException(key, outletIds)) continue;
      collisions.push({ key, outletIds });
    }
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Would registering `candidateId` with `candidateEntry` (displayName/aliases)
 * create a near-duplicate against the outlets already in the registry?
 *
 * For callers that AUTO-CREATE new outlet entries from raw review outletIds
 * (rebuild-all-reviews.js's AUTO-REGISTER NEW OUTLETS block) — mirrors
 * wouldCauseDomainCollision()'s write-time-gate pattern
 * (scripts/lib/outlet-registry-domain-collisions.js) for the alias-collision
 * class of near-duplicate (the-la-times/latimes, BRO-90 / task #1838).
 *
 * Unlike `domain`, a new outlet's identity (id/displayName) isn't optional —
 * there's no null-able field to degrade to. Callers should treat `true` as
 * "do not write this outlet into the registry" and log loudly instead, so
 * the review still resolves by its literal outletId (getOutletTier/
 * getOutletDisplayName both degrade gracefully for an unregistered id —
 * tier 3 default, raw-id display fallback) rather than silently stealing
 * another outlet's byline-matched reviews.
 *
 * Pass the registry's CURRENT `outlets` map at call time (already including
 * any candidates from earlier in the same batch that were admitted) so two
 * colliding new outlet IDs registered in the same rebuild run are each
 * checked against what came before them, not just against the pre-batch
 * registry.
 *
 * @param {object} outlets - registry.outlets map (id → entry), NOT yet
 *   containing candidateId
 * @param {object} [aliasIndex] - registry._aliasIndex map
 * @param {string} candidateId
 * @param {object} candidateEntry - { displayName, aliases, ... }
 * @returns {boolean}
 */
function wouldCauseAliasCollision(outlets, aliasIndex, candidateId, candidateEntry) {
  const withCandidate = { ...(outlets || {}), [candidateId]: candidateEntry };
  const collisions = findOutletAliasCollisions(withCandidate, aliasIndex);
  return collisions.some((c) => c.outletIds.includes(candidateId));
}

module.exports = {
  stripLeadingThe,
  expandTextKeyForms,
  buildOutletTextKeys,
  findOutletAliasCollisions,
  wouldCauseAliasCollision,
  DECLARED_THE_EXCEPTIONS,
};
