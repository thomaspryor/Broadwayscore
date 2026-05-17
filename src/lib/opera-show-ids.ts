/**
 * Static list of opera show ID slugs. Opera shows currently live under the
 * /show/{slug}-off-broadway-{year} URL pattern (the off-broadway routing
 * convention is structural and shared with Off-Broadway shows). This list
 * exists so the UI can render opera-aware chrome (Opera pill, methodology
 * footer) on opera show pages without needing per-page data fetches.
 *
 * **Maintenance:** when a new Met production is added to shows.json with
 * `type: 'opera'`, add its ID prefix here. Notion 363637c5-416f-8113 tracks
 * auto-generating this from `getOperaShows()` at build time so the list
 * doesn't drift.
 */
export const OPERA_SHOW_ID_PREFIXES: ReadonlySet<string> = new Set([
  'innocence-off-broadway',
  'el-ultimo-sueno-de-frida-y-diego-off-broadway',
  'la-traviata-off-broadway',
  'eugene-onegin-off-broadway',
  'tristan-und-isolde-off-broadway',
  'the-amazing-adventures-of-kavalier-and-clay-off-broadway',
]);

/**
 * Returns true if the given show ID or slug refers to a Met Opera production.
 * Accepts ids with or without a trailing -YYYY (e.g. both
 * "eugene-onegin-off-broadway-2026" and "eugene-onegin-off-broadway").
 */
export function isOperaShowId(idOrSlug: string | null | undefined): boolean {
  if (!idOrSlug) return false;
  // Strip trailing -YYYY year suffix if present
  const stripped = idOrSlug.replace(/-\d{4}$/, '');
  return OPERA_SHOW_ID_PREFIXES.has(stripped);
}

/**
 * Returns true if the given pathname is a Met Opera show detail page
 * (e.g. /show/eugene-onegin-off-broadway-2026).
 */
export function isOperaShowPath(pathname: string): boolean {
  if (!pathname.startsWith('/show/')) return false;
  const slug = pathname.slice(6).split('?')[0].split('#')[0];
  return isOperaShowId(slug);
}
