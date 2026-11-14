/**
 * CommonJS port of src/lib/homepage-notability.ts (BRO-7413), so scripts decide "is this
 * Off-Broadway show notable" with the homepage's own rule. The TypeScript module is the
 * source of truth; scripts/lib/homepage-notability.test.mjs transpiles it and fails when
 * this port disagrees on any signal combination or any real show.
 */

const NOTABILITY_THRESHOLDS = {
  minT1: 4,
  minReviews: 18,
  minCuratedAudience: 250,
  minKnownPropertyReviews: 4,
  minKnownPropertyScore: 80,
  cap: 8,
};

const KNOWN_PROPERTY_TAGS = new Set(['revival', 'classic', 'tony-winner']);

function isKnownProperty(s) {
  if (s.isRevival) return true;
  const tags = (s.tags || []).map(t => t.toLowerCase());
  return tags.some(t => KNOWN_PROPERTY_TAGS.has(t));
}

function isAcclaimedKnownPropertyRevival(s) {
  if (s.homepageExclude) return false;
  if (s.status !== 'open' && s.status !== 'previews') return false;
  if (s.type === 'opera') return false;
  return isKnownProperty(s)
    && s.reviewCount >= NOTABILITY_THRESHOLDS.minKnownPropertyReviews
    && (s.criticScore ?? 0) >= NOTABILITY_THRESHOLDS.minKnownPropertyScore;
}

function isHomepageNotable(s) {
  if (s.homepageExclude) return false;
  if (s.homepageInclude) return true;
  if (s.status !== 'open' && s.status !== 'previews') return false;
  if (s.type === 'opera') return false;
  if (s.t1Count >= NOTABILITY_THRESHOLDS.minT1) return true;
  if (s.reviewCount >= NOTABILITY_THRESHOLDS.minReviews) return true;
  if (isKnownProperty(s) && s.curatedAudience >= NOTABILITY_THRESHOLDS.minCuratedAudience) return true;
  if (isAcclaimedKnownPropertyRevival(s)) return true;
  return false;
}

module.exports = { NOTABILITY_THRESHOLDS, isHomepageNotable, isAcclaimedKnownPropertyRevival };
