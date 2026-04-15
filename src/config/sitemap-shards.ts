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
  // Normalize unicode (é → e, ö → o) so accented names bucket by base letter.
  const normalized = slug.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const first = normalized.charAt(0);
  // Only bucket by letter for a-z. Non-letter starts (digits, symbols, empty)
  // fall to actors-ah as the default catch-all.
  if (first < 'a' || first > 'z') return 'actors-ah';
  if (first <= 'h') return 'actors-ah';
  if (first <= 'q') return 'actors-iq';
  return 'actors-rz';
}
