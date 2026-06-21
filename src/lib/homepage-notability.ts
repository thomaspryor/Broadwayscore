// Notability gate for surfacing off-Broadway shows on the Broadway homepage grid.
//
// The default homepage is Broadway-only (getBroadwayShows), which goes stale when
// few Broadway shows are opening. This picks a small, high-signal subset of
// off-Broadway shows to mix in — measured by ATTENTION, not score (a heavily
// reviewed pan is still notable).
//
// Two independent paths in, because notability comes from two different places:
//   A) Critics showed up — a major-critic turnout (T1) or broad coverage. This
//      is what the NYT/Vulture/Variety reviewing an OB show signals.
//   B) Known property with audience buzz — a recognizable revival/title that
//      critics didn't re-review heavily but audiences are actually attending.
// A single review-count threshold gets these backwards: it over-rewards small
// critics'-darling new plays and misses recognizable revivals. Hence two paths.
//
// Plus a manual editorial override for star-driven shows in previews before any
// reviews land (auto-scoring can't see those yet).
//
// Pure module — no data imports — so it unit-tests cleanly and the data
// orchestration stays in src/lib/data-core.ts (getNotableOffBroadwayShows).

export interface NotabilitySignals {
  status: string;                 // 'open' | 'previews' | 'closed' | ...
  type?: string;                  // 'musical' | 'play' | 'opera' | ...
  isRevival?: boolean;
  tags?: string[];
  /** Tier-1 (NYT/Vulture/Variety etc.) scored review count. */
  t1Count: number;
  /** Total scored critic reviews. */
  reviewCount: number;
  /**
   * Curated audience footprint: sum of reviewCounts across ticket-buyer
   * platforms (Show Score + Mezzanine + Theatr + BroadwayBox). Reddit is
   * EXCLUDED on purpose — its volume is conversation noise, not attendance.
   */
  curatedAudience: number;
  /** Manual editorial force-in (e.g. star-driven previews show, pre-reviews). */
  homepageInclude?: boolean;
  /** Manual editorial veto — wins over everything. */
  homepageExclude?: boolean;
}

export const NOTABILITY_THRESHOLDS = {
  /** Path A — major-critic turnout. */
  minT1: 4,
  /** Path A — broad coverage regardless of tier. */
  minReviews: 18,
  /** Path B — curated audience footprint for a known property. */
  minCuratedAudience: 250,
  /** Cap on how many notable OB shows reach the homepage grid. */
  cap: 8,
} as const;

const KNOWN_PROPERTY_TAGS = new Set(['revival', 'classic', 'tony-winner']);

/** A recognizable title: a revival, or tagged classic/tony-winner. */
function isKnownProperty(s: NotabilitySignals): boolean {
  if (s.isRevival) return true;
  const tags = s.tags?.map(t => t.toLowerCase()) ?? [];
  return tags.some(t => KNOWN_PROPERTY_TAGS.has(t));
}

/**
 * Decide whether an off-Broadway show is "notable" enough to surface on the
 * Broadway homepage grid. Caller is responsible for having already restricted
 * to category === 'off-broadway'.
 */
export function isHomepageNotable(s: NotabilitySignals): boolean {
  // Manual flags win, exclude over include.
  if (s.homepageExclude) return false;
  if (s.homepageInclude) return true;
  // Gate: only currently-playing, non-opera shows (opera has its own shelf).
  if (s.status !== 'open' && s.status !== 'previews') return false;
  if (s.type === 'opera') return false;
  // Path A — critics showed up.
  if (s.t1Count >= NOTABILITY_THRESHOLDS.minT1) return true;
  if (s.reviewCount >= NOTABILITY_THRESHOLDS.minReviews) return true;
  // Path B — known property with real audience buzz.
  if (isKnownProperty(s) && s.curatedAudience >= NOTABILITY_THRESHOLDS.minCuratedAudience) return true;
  return false;
}

/**
 * Rank score for ordering eligible shows before the cap is applied — decides
 * "which 8 if more than 8 qualify." Weights critic turnout heavily, then
 * coverage breadth, then audience footprint. Never displayed to users.
 */
export function notabilityRank(s: NotabilitySignals): number {
  return s.t1Count * 1000 + s.reviewCount * 10 + Math.min(s.curatedAudience, 1_000_000) / 1000;
}
