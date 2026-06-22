/**
 * Gold Lists Configuration
 * Single source of truth for Gold List types, thresholds, and styling.
 * All Gold List components should import from here.
 */

import type { ShowCategory } from '@/lib/market-utils';

export type GoldListType =
  | 'critical-gold'
  | 'critical-gold-west-end'
  | 'critical-gold-off-broadway'
  | 'critical-gold-off-west-end'
  | 'audience-gold'
  | 'audience-gold-off-broadway'
  | 'audience-gold-west-end'
  | 'audience-gold-off-west-end'
  | 'box-office-gold'
  | 'hot-ticket-gold';

export interface GoldListConfig {
  type: GoldListType;
  /** Display title */
  title: string;
  /** Short title for tabs/pills */
  shortTitle: string;
  /** Description for index page and metadata */
  description: string;
  /** Tailwind text color class */
  color: string;
  /** Badge background class */
  bgClass: string;
  /** Badge border class */
  borderClass: string;
  /** Minimum score/value to qualify */
  threshold: number;
  /** Max shows per season list */
  maxPerSeason: number;
  /** Max shows on all-time list */
  maxAllTime: number;
  /** Label for the metric shown (e.g., "Critic Score") */
  metricLabel: string;
  /** Suffix for the metric value (e.g., "%", "/100") */
  metricSuffix: string;
  /** Minimum data requirements */
  minDataRequirement: string;
}

export const GOLD_LIST_CONFIGS: GoldListConfig[] = [
  {
    type: 'critical-gold',
    title: 'Critical Gold List™',
    shortTitle: 'Broadway',
    description: 'The highest-rated Broadway shows by professional critics',
    color: 'text-amber-400',
    bgClass: 'bg-amber-500/15',
    borderClass: 'border-amber-500/30',
    threshold: 73,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'CriticScore',
    metricSuffix: '',
    minDataRequirement: '5+ scored reviews',
  },
  {
    type: 'critical-gold-west-end',
    title: 'West End Critical Gold List\u2122',
    shortTitle: 'West End',
    description: 'The highest-rated West End shows by professional critics',
    color: 'text-sky-400',
    bgClass: 'bg-sky-500/15',
    borderClass: 'border-sky-500/30',
    threshold: 73,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'CriticScore',
    metricSuffix: '',
    minDataRequirement: '5+ scored reviews',
  },
  {
    type: 'critical-gold-off-broadway',
    title: 'Off-Broadway Critical Gold List\u2122',
    shortTitle: 'Off-Broadway',
    description: 'The highest-rated Off-Broadway shows by professional critics',
    color: 'text-teal-400',
    bgClass: 'bg-teal-500/15',
    borderClass: 'border-teal-500/30',
    threshold: 73,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'CriticScore',
    metricSuffix: '',
    minDataRequirement: '3+ scored reviews',
  },
  {
    type: 'critical-gold-off-west-end',
    title: 'Off-West End Critical Gold List\u2122',
    shortTitle: 'Off-West End',
    description: 'The highest-rated Off-West End shows by professional critics',
    color: 'text-indigo-400',
    bgClass: 'bg-indigo-500/15',
    borderClass: 'border-indigo-500/30',
    threshold: 73,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'CriticScore',
    metricSuffix: '',
    minDataRequirement: '3+ scored reviews',
  },
  {
    type: 'audience-gold',
    title: 'Audience Gold List™',
    shortTitle: 'Audiences',
    description: 'The shows audiences love most, based on combined audience platform scores',
    color: 'text-rose-400',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/30',
    threshold: 78,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'AudienceGrade',
    metricSuffix: '',
    minDataRequirement: 'AudienceGrade data available',
  },
  {
    type: 'audience-gold-off-broadway',
    title: 'Off-Broadway Audience Gold List\u2122',
    shortTitle: 'OB Audiences',
    description: 'The Off-Broadway shows audiences love most, based on combined audience platform scores',
    color: 'text-rose-400',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/30',
    threshold: 78,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'AudienceGrade',
    metricSuffix: '',
    minDataRequirement: 'AudienceGrade data available',
  },
  {
    type: 'audience-gold-west-end',
    title: 'West End Audience Gold List\u2122',
    shortTitle: 'WE Audiences',
    description: 'The West End shows audiences love most, based on combined audience platform scores',
    color: 'text-rose-400',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/30',
    threshold: 78,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'AudienceGrade',
    metricSuffix: '',
    minDataRequirement: 'AudienceGrade data available',
  },
  {
    type: 'audience-gold-off-west-end',
    title: 'Off-West End Audience Gold List\u2122',
    shortTitle: 'OWE Audiences',
    description: 'The Off-West End shows audiences love most, based on combined audience platform scores',
    color: 'text-rose-400',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/30',
    threshold: 78,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'AudienceGrade',
    metricSuffix: '',
    minDataRequirement: 'AudienceGrade data available',
  },
  {
    type: 'box-office-gold',
    title: 'Box Office Gold List™',
    shortTitle: 'Box Office',
    description: 'The biggest earners on Broadway, ranked by gross per performance',
    color: 'text-emerald-400',
    bgClass: 'bg-emerald-500/15',
    borderClass: 'border-emerald-500/30',
    threshold: 0,  // No score threshold — top N by gross/performance
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'Gross/Perf',
    metricSuffix: '',
    minDataRequirement: '50+ performances',
  },
  {
    type: 'hot-ticket-gold',
    title: 'Hot Ticket Gold List™',
    shortTitle: 'Hot Tickets',
    description: 'The hardest tickets to get on Broadway, ranked by average capacity percentage',
    color: 'text-violet-400',
    bgClass: 'bg-violet-500/15',
    borderClass: 'border-violet-500/30',
    threshold: 85,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'Avg Capacity',
    metricSuffix: '%',
    minDataRequirement: '8+ weeks of capacity data',
  },
];

/** Quick lookup: list type → config */
export const GOLD_LIST_MAP: Record<GoldListType, GoldListConfig> =
  Object.fromEntries(GOLD_LIST_CONFIGS.map(c => [c.type, c])) as Record<GoldListType, GoldListConfig>;

/** All valid list type slugs */
export const GOLD_LIST_TYPES: GoldListType[] = GOLD_LIST_CONFIGS.map(c => c.type);

/** Get config for a list type. Returns undefined for invalid types. */
export function getGoldListConfig(type: string): GoldListConfig | undefined {
  return GOLD_LIST_MAP[type as GoldListType];
}

/** Check if a string is a valid Gold List type */
export function isValidGoldListType(type: string): type is GoldListType {
  return GOLD_LIST_TYPES.includes(type as GoldListType);
}

/**
 * Map a list type to the ShowCategory its entries belong to.
 * Returns undefined for Broadway-only lists (which use venue-based membership, not `category`).
 * Use this for scoring tier thresholds, metadata strings, and `listCategory` props
 * — NEVER derive market from `listType.includes('west-end')`, which incorrectly
 * matches 'critical-gold-off-west-end' as West End.
 */
export function marketFromListType(listType: GoldListType): ShowCategory | undefined {
  switch (listType) {
    case 'critical-gold-off-broadway':
    case 'audience-gold-off-broadway':
      return 'off-broadway';
    case 'critical-gold-west-end':
    case 'audience-gold-west-end':
      return 'west-end';
    case 'critical-gold-off-west-end':
    case 'audience-gold-off-west-end':
      return 'off-west-end';
    case 'critical-gold':
    case 'audience-gold':
    case 'box-office-gold':
    case 'hot-ticket-gold':
      return undefined; // Broadway (venue-based membership)
  }
}

/** Human-readable market label for a list type — used in metadata/breadcrumbs. */
export function marketLabelFromListType(listType: GoldListType): string {
  const market = marketFromListType(listType);
  switch (market) {
    case 'off-broadway': return 'Off-Broadway';
    case 'west-end': return 'West End';
    case 'off-west-end': return 'Off-West End';
    case 'regional': return 'Regional';
    case 'broadway':
    case undefined:
      return 'Broadway';
  }
}

/* ─── Market / venue-tier navigation helpers ─── */

export type GoldListMarket = 'new-york' | 'london';
export type VenueTier = 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end';

/** Which top-level market does this list belong to? */
export function getMarketForListType(listType: GoldListType): GoldListMarket {
  switch (listType) {
    case 'critical-gold-west-end':
    case 'critical-gold-off-west-end':
    case 'audience-gold-west-end':
    case 'audience-gold-off-west-end':
      return 'london';
    default:
      return 'new-york';
  }
}

/** Venue tiers available for a market, in display order. */
export function getVenueTiersForMarket(market: GoldListMarket): VenueTier[] {
  return market === 'london'
    ? ['west-end', 'off-west-end']
    : ['broadway', 'off-broadway'];
}

/** Which venue tier does this list type belong to? */
export function getVenueTierForListType(listType: GoldListType): VenueTier {
  switch (listType) {
    case 'critical-gold-off-broadway':
    case 'audience-gold-off-broadway':
      return 'off-broadway';
    case 'critical-gold-west-end':
    case 'audience-gold-west-end':
      return 'west-end';
    case 'critical-gold-off-west-end':
    case 'audience-gold-off-west-end':
      return 'off-west-end';
    default: return 'broadway'; // critical-gold, audience-gold, box-office-gold, hot-ticket-gold
  }
}

/** All list types available for a venue tier, in display order. */
export function getListTypesForVenueTier(tier: VenueTier): GoldListType[] {
  switch (tier) {
    case 'broadway':
      return ['critical-gold', 'audience-gold', 'box-office-gold', 'hot-ticket-gold'];
    case 'off-broadway':
      return ['critical-gold-off-broadway', 'audience-gold-off-broadway'];
    case 'west-end':
      return ['critical-gold-west-end', 'audience-gold-west-end'];
    case 'off-west-end':
      return ['critical-gold-off-west-end', 'audience-gold-off-west-end'];
  }
}

/** Default list type when switching to a venue tier. */
export function getDefaultListTypeForVenueTier(tier: VenueTier): GoldListType {
  return getListTypesForVenueTier(tier)[0];
}

/** Human-readable label for a venue tier. */
export function venueTierLabel(tier: VenueTier): string {
  switch (tier) {
    case 'broadway': return 'Broadway';
    case 'off-broadway': return 'Off-Broadway';
    case 'west-end': return 'West End';
    case 'off-west-end': return 'Off-West End';
  }
}

/** Human-readable label for a market. */
export function marketLabel(market: GoldListMarket): string {
  return market === 'london' ? 'London' : 'New York';
}
