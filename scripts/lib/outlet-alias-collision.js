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
 * Find text keys claimed by 2+ distinct outlet IDs — i.e. outlets whose
 * identity (id/displayName/alias, raw or the-stripped) collides with
 * another outlet's identity in buildRegistryAliasMap()'s resolution surface.
 *
 * @param {object} outlets - registry.outlets map (id → entry)
 * @returns {Array<{key: string, outletIds: string[]}>} collision groups,
 *   sorted by key
 */
function findOutletAliasCollisions(outlets) {
  const byKey = new Map();

  for (const [id, entry] of Object.entries(outlets || {})) {
    if (id === '_aliasIndex' || id === '_meta' || !entry) continue;
    if (isSentinelOutletId(id)) continue;

    for (const key of buildOutletTextKeys(id, entry)) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(id);
    }
  }

  const collisions = [];
  for (const [key, ids] of byKey) {
    if (ids.size > 1) {
      collisions.push({ key, outletIds: [...ids].sort() });
    }
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = {
  stripLeadingThe,
  buildOutletTextKeys,
  findOutletAliasCollisions,
};
