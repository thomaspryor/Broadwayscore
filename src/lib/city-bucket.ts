/**
 * Pure category -> related-shows "city" bucket (BRO-2485, S4-T3).
 *
 * Only the categories listed here may form their own bucket. Anything else
 * (an unenumerated future category such as 'off-off-broadway', a typo, a blank)
 * folds into 'nyc' so it relates to NYC shows instead of becoming a
 * single-member bucket with zero related shows (a dead-end page).
 * Kept dependency-free so tests/unit can import it under plain node.
 */
export type CityBucket = 'nyc' | 'london' | 'regional' | 'tour';

const OWN_BUCKET = new Set(['regional', 'tour']);

export function categoryToCityBucket(category?: string | null): CityBucket {
  const cat = category || 'broadway';
  if (cat === 'broadway' || cat === 'off-broadway') return 'nyc';
  if (cat === 'west-end' || cat === 'off-west-end') return 'london';
  if (OWN_BUCKET.has(cat)) return cat as CityBucket;
  return 'nyc';
}
