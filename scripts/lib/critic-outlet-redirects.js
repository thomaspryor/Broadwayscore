'use strict';

const { slugify } = require('./url-slug');
const {
  flattenCriticSlugAliases, criticSlugsFromReviews, dropAliasesWithoutLiveCanonical,
} = require('./critic-slug-aliases');
// Retired routes observed in Vercel logs (BRO-7234). Keep only route slugs,
// never request metadata. Do not generate every possible critic/outlet pair.
const retiredSlugs = require('./retired-critic-outlet-slugs.json');

function deriveCriticOutletAliases(observedSlugs, liveSlugs, registry) {
  const aliases = {};
  if (!liveSlugs) return aliases;
  const outletSlugs = new Set();
  for (const [id, outlet] of Object.entries(registry.outlets || registry)) {
    if (id.startsWith('_') || !outlet || typeof outlet !== 'object') continue;
    for (const name of [id, outlet.displayName, ...(outlet.aliases || [])]) {
      if (typeof name === 'string' && name.trim()) outletSlugs.add(slugify(name));
    }
  }
  for (const oldSlug of observedSlugs) {
    if (typeof oldSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(oldSlug)) {
      throw new Error('Observed critic slugs must be lowercase route slugs, not URLs or log records');
    }
    if (liveSlugs.has(oldSlug)) continue;
    const matches = [];
    for (let i = oldSlug.indexOf('-'); i !== -1; i = oldSlug.indexOf('-', i + 1)) {
      const canonical = oldSlug.slice(0, i);
      const suffix = oldSlug.slice(i + 1).replace(/^for-/, '');
      if (liveSlugs.has(canonical) && outletSlugs.has(suffix)) matches.push(canonical);
    }
    // Ambiguous prefixes are an identity decision, never guess a redirect.
    if (matches.length === 1) aliases[oldSlug] = matches[0];
  }
  return aliases;
}

function buildLiveCriticAliases({ aliases, reviews, shows, outlets }) {
  const live = reviews ? criticSlugsFromReviews(reviews, shows) : null;
  const derived = deriveCriticOutletAliases(retiredSlugs, live, outlets);
  // Explicit curated aliases retain precedence. Flatten after merging so
  // curated chains through a retired outlet twin still resolve in one hop.
  const flat = flattenCriticSlugAliases({ ...derived, ...aliases });
  const filtered = dropAliasesWithoutLiveCanonical(
    flat.aliases, live, reviews ? criticSlugsFromReviews(reviews) : undefined,
  );
  return { aliases: filtered.aliases, dropped: [...flat.dropped, ...filtered.dropped] };
}

function findMissingCriticOutletAliases(observedSlugs, liveSlugs, outlets, aliases) {
  return Object.entries(deriveCriticOutletAliases(observedSlugs, liveSlugs, outlets))
    .filter(([slug, canonical]) => aliases[slug] !== canonical)
    .map(([slug, canonical]) => ({ slug, canonical }));
}

module.exports = { buildLiveCriticAliases, deriveCriticOutletAliases, findMissingCriticOutletAliases, retiredSlugs };
