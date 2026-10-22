// Tier weights, same shape as Broadway Scorecard's src/config/scoring.ts.
export const TIER_WEIGHTS: Record<1 | 2 | 3 | 4, number> = {
  1: 1.0,
  2: 0.75,
  3: 0.4,
  4: 0.2,
};

export const TIER_DESCRIPTIONS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Major national outlets with full-time reviews staff (The Verge, WSJ, CNET, Engadget, Wired)',
  2: 'Large dedicated tech publications (Tom\'s Guide, TechRadar, PCMag, ZDNET, Digital Trends)',
  3: 'Specialist outlets and general-interest publications (GSMArena, Pocket-lint, Popular Mechanics, Daily Mail)',
  4: 'Blogs, newsletters and smaller outlets',
};

/** Minimum reviews before a product gets a score instead of TBD. */
export const MIN_REVIEWS_FOR_SCORE = 5;
