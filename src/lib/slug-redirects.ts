/**
 * Pure resolution over data/slug-redirects-compact.json — the map
 * scripts/build-slug-redirects.js writes at prebuild.
 *
 * Namespaces sharing one flat map:
 *   - show entries:   { "<old-or-versionless-slug>": "<slug>" }, a "~" value
 *                     prefix meaning temporary (302: a versionless slug that
 *                     names several productions), otherwise permanent (301)
 *   - critic entries: { "critic:<old-slug>": "<canonical-slug>" }, always 301
 *                     (2026 data audit, S5-T9; source: data/critic-slug-aliases.json)
 *   - name entries:   { "<family>:<old-slug>": "<live-slug>" }, always 301, one
 *                     prefix per name-derived route family (NAME_REDIRECT_PREFIXES:
 *                     /creative, /theater, /west-end/theater, /off-broadway/theater,
 *                     /cast). Derived at prebuild from the data the pages are
 *                     built from — the URLs the S7-T3 diacritic fold moved
 *                     (scripts/lib/name-slug-redirects.js).
 *
 * Kept free of node/next imports so src/middleware.ts (edge runtime) and the
 * server-side lookups (data-reviews.ts getCriticBySlug, data-creative.ts
 * getUnifiedCreativeProfile, data-core.ts getTheaterBySlug /
 * getLondonTheaterBySlug / getOffBroadwayTheaterBySlug, data-actors.ts
 * getActorBySlug) resolve through the SAME functions and can never disagree
 * about where an old URL goes.
 */

// Mirrored verbatim in scripts/lib/critic-slug-aliases.js (the emitter, which
// the edge bundle cannot require); tests/unit/slug-redirects.test.ts asserts parity.
export const CRITIC_REDIRECT_PREFIX = 'critic:';

// Mirrored verbatim in scripts/lib/name-slug-redirects.js NAME_REDIRECT_PREFIXES
// (same reason); tests/unit/slug-redirects.test.ts asserts parity.
export const NAME_REDIRECT_PREFIXES = {
  creative: 'creative:',
  theater: 'theater:',
  westEndTheater: 'west-end-theater:',
  offBroadwayTheater: 'off-broadway-theater:',
  cast: 'cast:',
} as const;

export type NameRedirectFamily = keyof typeof NAME_REDIRECT_PREFIXES;

/**
 * Route prefix → family, for resolvePathRedirect. src/middleware.ts's
 * `config.matcher` must stay a static literal (Next analyses it at build
 * time), so it lists these same routes by hand; the middleware test asserts
 * the two agree.
 */
export const NAME_ROUTE_FAMILIES: ReadonlyArray<{ family: NameRedirectFamily; route: string }> = [
  { family: 'creative', route: '/creative/' },
  { family: 'theater', route: '/theater/' },
  { family: 'westEndTheater', route: '/west-end/theater/' },
  { family: 'offBroadwayTheater', route: '/off-broadway/theater/' },
  { family: 'cast', route: '/cast/' },
];

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
  // namespaced (critic / name-family) key through the show namespace.
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

/**
 * <family route>/<rawSlug> → live slug, or null when the slug is not a
 * retired (pre-fold) slug of that family. Families never see each other's
 * keys: /theater/x and /west-end/theater/x resolve through different prefixes.
 */
export function resolveNameRedirect(map: SlugRedirectMap, family: NameRedirectFamily, rawSlug: string): string | null {
  if (!rawSlug) return null;
  return map[NAME_REDIRECT_PREFIXES[family] + rawSlug.toLowerCase()] || null;
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
 * to the page (which may 404). Handles /show/<slug>, /critics/<slug> and the
 * name-derived families in NAME_ROUTE_FAMILIES — single segment only; nested
 * paths fall through.
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

  for (const { family, route } of NAME_ROUTE_FAMILIES) {
    const slug = singleSegmentAfter(pathname, route);
    if (slug === null) continue;
    const target = resolveNameRedirect(map, family, slug);
    return target ? { pathname: `${route}${target}`, status: 301 } : null;
  }

  return null;
}
