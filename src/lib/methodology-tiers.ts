/**
 * Outlets named under each tier on the methodology pages (/methodology and
 * /west-end/methodology), by market (BRO-4925).
 *
 * The lists used to be typed into the page by hand and drifted: the Daily
 * Mail was listed as London Tier 2 while outlet-tiers.json had it at Tier 1,
 * and Playbill was listed at Tier 2 with no tier entry at all. They are now
 * outlet-tiers.json ids, names come from that file, and
 * tests/unit/tier-config-consistency.test.ts fails if a listed outlet is not
 * in the claimed tier for that market.
 *
 * Server-only: imports outlet-tiers.json (the pages are static server components).
 */
import outletTiers from '@/config/outlet-tiers.json';

export type MethodologyMarket = 'nyc' | 'london';

export const METHODOLOGY_TIER_OUTLETS: Record<MethodologyMarket, Record<1 | 2, readonly string[]>> = {
  nyc: {
    1: ['nytimes', 'vulture', 'variety', 'hollywood-reporter', 'wsj', 'washpost', 'newyorker', 'timeout',
      'broadwaynews', 'deadline', 'ap', 'newsday', 'latimes', 'guardian'],
    2: ['theatermania', 'nysr', 'broadwayworld', 'nytg', 'theatrely', 'nydailynews', 'nypost', 'theater-life',
      'theater-scene', 'cititour', 'talkinbroadway', 'backstage', 'ew', 'rollingstone',
      'people', 'slate', 'indiewire'],
  },
  london: {
    1: ['guardian', 'times-uk', 'telegraph', 'standard', 'financialtimes', 'thestage', 'timeout-london',
      'independent', 'observer', 'daily-mail', 'i-paper'],
    2: ['whatsonstage', 'london-theatre', 'thereviewshub', 'artsdesk', 'british-theatre', 'the-spectator-uk',
      'london-box-office', 'broadwayworld', 'nytimes'],
  },
};

// Reader-facing names where outlet-tiers.json's name carries a disambiguating suffix.
const DISPLAY_NAMES: Record<string, string> = {
  'times-uk': 'The Times',
  'the-spectator-uk': 'The Spectator',
  observer: 'The Observer',
  ap: 'AP',
  'i-paper': 'the i',
};

type TierEntry = { name?: string; tier?: number; tiers?: Partial<Record<MethodologyMarket, number>> };
const TIERS = outletTiers as unknown as Record<string, TierEntry>;

export function outletDisplayName(id: string): string {
  return DISPLAY_NAMES[id] ?? TIERS[id]?.name ?? id;
}

/** The outlet's tier for a market, as outlet-tiers.json resolves it (regional override, else base tier). */
export function outletMarketTier(id: string, market: MethodologyMarket): number | undefined {
  const e = TIERS[id];
  return e ? (e.tiers?.[market] ?? e.tier) : undefined;
}

/** "A, B and C" */
export function methodologyOutletList(market: MethodologyMarket, tier: 1 | 2): string {
  const names = METHODOLOGY_TIER_OUTLETS[market][tier].map(outletDisplayName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}
