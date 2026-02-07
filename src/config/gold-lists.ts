/**
 * Gold Lists Configuration
 * Single source of truth for Gold List types, thresholds, and styling.
 * All Gold List components should import from here.
 */

export type GoldListType = 'critical-gold' | 'audience-gold' | 'box-office-gold' | 'hot-ticket-gold';

export interface GoldListConfig {
  type: GoldListType;
  /** Display title */
  title: string;
  /** Short title for tabs/pills */
  shortTitle: string;
  /** Description for index page and metadata */
  description: string;
  /** Icon character */
  icon: string;
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
    title: 'Critical Gold List',
    shortTitle: 'Critics',
    description: 'The highest-rated shows by professional critics, weighted by outlet tier',
    icon: '🏆',
    color: 'text-amber-400',
    bgClass: 'bg-amber-500/15',
    borderClass: 'border-amber-500/30',
    threshold: 73,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'Critic Score',
    metricSuffix: '',
    minDataRequirement: '5+ scored reviews',
  },
  {
    type: 'audience-gold',
    title: 'Audience Gold List',
    shortTitle: 'Audiences',
    description: 'The shows audiences love most, based on combined audience platform scores',
    icon: '💛',
    color: 'text-rose-400',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/30',
    threshold: 78,
    maxPerSeason: 10,
    maxAllTime: 25,
    metricLabel: 'Audience Score',
    metricSuffix: '',
    minDataRequirement: 'Combined audience score available',
  },
  {
    type: 'box-office-gold',
    title: 'Box Office Gold List',
    shortTitle: 'Box Office',
    description: 'The biggest earners on Broadway, ranked by gross per performance',
    icon: '💰',
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
    title: 'Hot Ticket Gold List',
    shortTitle: 'Hot Tickets',
    description: 'The hardest tickets to get on Broadway, ranked by average capacity percentage',
    icon: '🔥',
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
