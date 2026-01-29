/**
 * Single source of truth for commercial designation config.
 * All components should import from here - never hardcode designation
 * colors, sort orders, or descriptions elsewhere.
 */

export type CommercialDesignation =
  | 'Miracle'
  | 'Windfall'
  | 'Easy Winner'
  | 'Trickle'
  | 'TBD'
  | 'Fizzle'
  | 'Flop'
  | 'Nonprofit'
  | 'Tour Stop';

export interface DesignationConfig {
  name: CommercialDesignation;
  /** Tailwind text color class */
  color: string;
  /** Short description for legend / tooltips */
  description: string;
  /** Sort order (1 = best, higher = worse) */
  sortOrder: number;
  /** Whether to show in the public designation legend */
  showInLegend: boolean;
  /** Emoji icon for cards/tables */
  icon: string;
  /** Badge background class */
  bgClass: string;
  /** Badge border class */
  borderClass: string;
}

/**
 * Master designation config - ordered by sortOrder.
 * Add new designations here and they'll appear everywhere automatically.
 */
export const DESIGNATIONS: DesignationConfig[] = [
  {
    name: 'Miracle',
    color: 'text-yellow-400',
    description: 'Long-running mega-hit, extraordinary returns',
    sortOrder: 1,
    showInLegend: true,
    icon: '✨',
    bgClass: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
    borderClass: 'border-amber-500/30',
  },
  {
    name: 'Windfall',
    color: 'text-emerald-400',
    description: 'Solid hit, recouped and profitable',
    sortOrder: 2,
    showInLegend: true,
    icon: '💰',
    bgClass: 'bg-emerald-500/15',
    borderClass: 'border-emerald-500/25',
  },
  {
    name: 'Easy Winner',
    color: 'text-lime-400',
    description: 'Limited run that recouped quickly',
    sortOrder: 3,
    showInLegend: true,
    icon: '🎁',
    bgClass: 'bg-lime-500/15',
    borderClass: 'border-lime-500/25',
  },
  {
    name: 'Trickle',
    color: 'text-cyan-400',
    description: 'Broke even or modest profit',
    sortOrder: 4,
    showInLegend: true,
    icon: '💧',
    bgClass: 'bg-cyan-500/15',
    borderClass: 'border-cyan-500/25',
  },
  {
    name: 'TBD',
    color: 'text-gray-400',
    description: 'Too early to tell (still running)',
    sortOrder: 5,
    showInLegend: false,
    icon: '⏳',
    bgClass: 'bg-gray-500/15',
    borderClass: 'border-gray-500/25',
  },
  {
    name: 'Fizzle',
    color: 'text-orange-400',
    description: 'Closed without recouping (~30%+ back)',
    sortOrder: 6,
    showInLegend: true,
    icon: '📉',
    bgClass: 'bg-orange-500/15',
    borderClass: 'border-orange-500/25',
  },
  {
    name: 'Flop',
    color: 'text-red-400',
    description: 'Closed without recouping (<30% back)',
    sortOrder: 7,
    showInLegend: true,
    icon: '💸',
    bgClass: 'bg-red-500/15',
    borderClass: 'border-red-500/25',
  },
  {
    name: 'Nonprofit',
    color: 'text-blue-400',
    description: 'Nonprofit production (LCT, Roundabout, etc.)',
    sortOrder: 8,
    showInLegend: true,
    icon: '🎭',
    bgClass: 'bg-blue-500/15',
    borderClass: 'border-blue-500/25',
  },
  {
    name: 'Tour Stop',
    color: 'text-slate-400',
    description: 'National tour engagement on Broadway',
    sortOrder: 9,
    showInLegend: true,
    icon: '🚌',
    bgClass: 'bg-slate-500/15',
    borderClass: 'border-slate-500/25',
  },
];

/** Quick lookup: designation name → config */
export const DESIGNATION_MAP: Record<string, DesignationConfig> =
  Object.fromEntries(DESIGNATIONS.map(d => [d.name, d]));

/** Get designation color class. Falls back to gray for unknown. */
export function getDesignationColor(designation: string): string {
  return DESIGNATION_MAP[designation]?.color || 'text-gray-400';
}

/** Get designation sort order. Falls back to 99 for unknown. */
export function getDesignationSortOrder(designation: string): number {
  return DESIGNATION_MAP[designation]?.sortOrder || 99;
}

/** Get designation icon. Falls back to '?' for unknown. */
export function getDesignationIcon(designation: string): string {
  return DESIGNATION_MAP[designation]?.icon || '?';
}

/** Get full badge style for designation cards. */
export function getDesignationBadgeStyle(designation: string): {
  bgClass: string;
  textClass: string;
  borderClass: string;
  icon: string;
  description: string;
} {
  const config = DESIGNATION_MAP[designation];
  if (!config) {
    return {
      bgClass: 'bg-gray-500/15',
      textClass: 'text-gray-400',
      borderClass: 'border-gray-500/25',
      icon: '?',
      description: 'Unknown',
    };
  }
  return {
    bgClass: config.bgClass,
    textClass: config.color,
    borderClass: config.borderClass,
    icon: config.icon,
    description: config.description,
  };
}

/** Get designations to show in the legend */
export function getLegendDesignations(): DesignationConfig[] {
  return DESIGNATIONS.filter(d => d.showInLegend);
}

// ============================================
// Trend config (also centralized)
// ============================================

export type RecoupmentTrend = 'improving' | 'declining' | 'steady' | 'unknown';

export function getTrendColor(trend: RecoupmentTrend, recouped: boolean | null): string {
  if (recouped) return 'text-gray-500';
  switch (trend) {
    case 'improving': return 'text-emerald-400';
    case 'declining': return 'text-red-400';
    default: return 'text-gray-500';
  }
}

export function getTrendIcon(trend: RecoupmentTrend, recouped: boolean | null): string {
  if (recouped) return '—';
  switch (trend) {
    case 'improving': return '↑';
    case 'declining': return '↓';
    case 'steady': return '→';
    default: return '—';
  }
}
