/**
 * Reader-facing copy for the outlet tier chips on the Critic Scorecard
 * (BRO-4881). No imports, so it is safe for client components: pulling
 * TIER_WEIGHTS from ./scoring would drag outlet-tiers.json and other data
 * into the client bundle.
 *
 * `weight` mirrors TIER_WEIGHTS in ./scoring.ts.
 * tests/unit/tier-config-consistency.test.ts fails if the two drift apart.
 */

export type OutletTier = 1 | 2 | 3 | 4;

export interface TierDisplay {
  title: string;
  weight: number;
  /** How much this tier counts, relative to Tier 1, in plain words. */
  relative: string;
  /** Example outlets for NYC-market shows (Broadway, Off-Broadway, tours, regional). */
  examplesNyc: string;
  /** Example outlets for London-market shows (West End, Off-West End). */
  examplesLondon: string;
}

export const TIER_DISPLAY: Record<OutletTier, TierDisplay> = {
  1: {
    title: 'Anchor outlet',
    weight: 1.0,
    relative: 'Counts in full.',
    examplesNyc: 'The New York Times, Vulture, Variety, The Hollywood Reporter, WSJ, The New Yorker.',
    examplesLondon: 'The Guardian, The Times, The Telegraph, Evening Standard, The Stage, Time Out London.',
  },
  2: {
    title: 'Major outlet',
    weight: 0.75,
    relative: 'Counts ¾ as much as a Tier 1 review.',
    examplesNyc: 'TheaterMania, New York Stage Review, BroadwayWorld, New York Theatre Guide, Daily News, NY Post.',
    examplesLondon: 'WhatsOnStage, London Theatre, The Reviews Hub, The Arts Desk.',
  },
  3: {
    title: 'General coverage',
    weight: 0.4,
    relative: 'Counts 40% as much as a Tier 1 review.',
    examplesNyc: 'Smaller theater outlets and established single-critic sites.',
    examplesLondon: 'Smaller theater outlets and established single-critic sites.',
  },
  4: {
    title: 'Independent blog',
    weight: 0.2,
    relative: 'Counts 20% as much as a Tier 1 review.',
    examplesNyc: "Single-author blogs we haven't verified yet.",
    examplesLondon: "Single-author blogs we haven't verified yet.",
  },
};

export const TIER_LIST: readonly OutletTier[] = [1, 2, 3, 4];

/** Signal bars lit on the tier chip: 4 for Tier 1 down to 1 for Tier 4 (BRO-4905). */
export function tierBarsLit(tier: OutletTier): number {
  return 5 - tier;
}

/** A tier's weight as a whole percent of a Tier 1 review, for the "Counts" key. */
export function tierPercent(tier: OutletTier): number {
  return Math.round(TIER_DISPLAY[tier].weight * 100);
}
