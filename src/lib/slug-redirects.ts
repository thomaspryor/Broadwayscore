/**
 * Pure resolution over data/slug-redirects-compact.json — the map
 * scripts/build-slug-redirects.js writes at prebuild.
 *
 * Two namespaces share one flat map:
 *   - show entries:   { "<old-or-versionless-slug>": "<slug>" }, a "~" value
 *                     prefix meaning temporary (302: a versionless slug that
 *                     names several productions), otherwise permanent (301)
 *   - critic entries: { "critic:<old-slug>": "<canonical-slug>" }, always 301
 *                     (2026 data audit, S5-T9; source: data/critic-slug-aliases.json)
 *
 * Kept free of node/next imports so src/middleware.ts (edge runtime) and
 * src/lib/data-reviews.ts (server) resolve through the SAME function and can
 * never disagree about where an old URL goes.
 */

// Mirrored verbatim in scripts/lib/critic-slug-aliases.js (the emitter, which
// the edge bundle cannot require); tests/unit/slug-redirects.test.ts asserts parity.
export const CRITIC_REDIRECT_PREFIX = 'critic:';

export type SlugRedirectMap = Readonly<Record<string, string>>;

export interface ShowRedirect {
  target: string;
  permanent: boolean;
}

export interface PathRedirect {
  pathname: string;
  status: 301 | 302;
}

/** /show/<rawSlug> → target slug + permanence, or null when the slug is not a redirect key. */
export function resolveShowRedirect(map: SlugRedirectMap, rawSlug: string): ShowRedirect | null {
  // slugify() never emits ":" — a colon can only be an attempt to reach a
  // namespaced (critic) key through the show namespace.
  if (!rawSlug || rawSlug.includes(':')) return null;
  const entry = map[rawSlug.toLowerCase()];
  if (!entry) return null;
  const temporary = entry.startsWith('~');
  return { target: temporary ? entry.slice(1) : entry, permanent: !temporary };
}

/** /critics/<rawSlug> → canonical critic slug, or null when the slug is not a retired alias. */
export function resolveCriticRedirect(map: SlugRedirectMap, rawSlug: string): string | null {
  if (!rawSlug) return null;
  return map[CRITIC_REDIRECT_PREFIX + rawSlug.toLowerCase()] || null;
}

/** The single path segment after `prefix`, or null for anything nested (e.g. /critics/outlets/<x>). */
function singleSegmentAfter(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).replace(/\/$/, '');
  if (!raw || raw.includes('/')) return null;
  return raw;
}

/**
 * Where a request pathname should redirect, or null to let it fall through
 * to the page (which may 404). Handles /show/<slug> and /critics/<slug>.
 */
export function resolvePathRedirect(map: SlugRedirectMap, pathname: string): PathRedirect | null {
  const showSlug = singleSegmentAfter(pathname, '/show/');
  if (showSlug !== null) {
    const hit = resolveShowRedirect(map, showSlug);
    return hit ? { pathname: `/show/${hit.target}`, status: hit.permanent ? 301 : 302 } : null;
  }

  const criticSlug = singleSegmentAfter(pathname, '/critics/');
  if (criticSlug !== null) {
    const target = resolveCriticRedirect(map, criticSlug);
    return target ? { pathname: `/critics/${target}`, status: 301 } : null;
  }

  return null;
}
