export const SITEMAP_SHARDS = [
  { name: 'core', label: 'Core pages (homepage, guides, browse, best-of, hubs, lists, compare, reviews)' },
  { name: 'shows', label: 'Show pages (all markets)' },
  { name: 'theaters', label: 'Theater pages (Broadway + London)' },
  { name: 'critics', label: 'Critics + outlets' },
  { name: 'creatives', label: 'Creative team pages (directors, playwrights, composers, lyricists)' },
  { name: 'actors-ah', label: 'Actor pages A-H' },
  { name: 'actors-iq', label: 'Actor pages I-Q' },
  { name: 'actors-rz', label: 'Actor pages R-Z' },
] as const;

export type ShardName = typeof SITEMAP_SHARDS[number]['name'];

export function getActorBucket(slug: string): 'actors-ah' | 'actors-iq' | 'actors-rz' {
  const first = slug.charAt(0).toLowerCase();
  if (first <= 'h') return 'actors-ah';
  if (first <= 'q') return 'actors-iq';
  return 'actors-rz';
}
