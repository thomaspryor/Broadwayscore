/**
 * Near-duplicate outlet-registry detector (the-la-times class, task #1838 / BRO-90).
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
 * Scope note: this covers the raw-text + "the "-stripped surface (id,
 * displayName, aliases, and _aliasIndex) but NOT normalizeOutlet()'s further
 * slugify()-based fallback (review-normalization.js:427-437) — a collision
 * that only appears after full slugification (e.g. punctuation differences)
 * would not be caught here. No known live case needs that wider check; add
 * it if one turns up.
 */

const { isSentinelOutletId } = require('./review-normalization');

/**
 * Strip a leading "the " (space-separated text) or "the-" (slug/id text)
 * prefix — mirrors normalizeOutlet's two withoutThe/slugWithoutThe forms.
 */
function stripLeadingThe(text) {
  return text.replace(/^the[\s-]+/, '');
}

/**
 * Build the same text-key resolution surface buildRegistryAliasMap() builds
 * for a single outlet: its id, displayName, and aliases, each in both raw
 * and "the "-stripped form.
 *
 * @param {string} outletId
 * @param {object} entry - registry.outlets[outletId]
 * @returns {string[]} lowercase text keys this outlet would resolve from
 */
function buildOutletTextKeys(outletId, entry) {
  const keys = new Set();
  const addKey = (text) => {
    if (!text) return;
    const lower = String(text).toLowerCase().trim();
    if (!lower) return;
    keys.add(lower);
    const stripped = stripLeadingThe(lower);
    if (stripped && stripped !== lower) keys.add(stripped);
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
 * the-stripped collision is a deliberate, investigated edition/masthead
 * split rather than a duplicate — same pattern as EDITION_PAIRS /
 * DECLARED_ALIAS_OVERLAPS in scripts/lib/outlet-registry-domain-collisions.js.
 * Empty today (no legitimate "the "-split outlet pair has been found); add
 * entries here instead of weakening the detector if one ever turns up.
 */
const DECLARED_THE_EXCEPTIONS = [];

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
    const lower = String(alias).toLowerCase().trim();
    if (!lower) continue;
    claim(lower, targetId);
    const stripped = stripLeadingThe(lower);
    if (stripped && stripped !== lower) claim(stripped, targetId);
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
  buildOutletTextKeys,
  findOutletAliasCollisions,
  wouldCauseAliasCollision,
  DECLARED_THE_EXCEPTIONS,
};
