/**
 * Single source of truth for commercial designation config.
 * All components should import from here - never hardcode designation
 * colors, sort orders, or descriptions elsewhere.
 */

// Thresholds have one definition, shared with the data pipeline (BRO-4989 C).
import { FIZZLE_MIN_RETURNED_PCT, WAIT_AND_SEE_MIN_RETURNED_PCT } from '../../scripts/lib/commercial-designations';

export type CommercialDesignation =
  | 'Miracle'
  | 'Windfall'
  | 'Easy Winner'
  | 'Trickle'
  | 'TBD'
  | 'Fizzle'
  | 'Did Not Recoup'
  | 'Flop'
  | 'Nonprofit'
  | 'Tour Stop'
  | 'Squeaker'
  | 'Wait & See';

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
    description: 'Solid hit, strong commercial performance',
    sortOrder: 2,
    showInLegend: true,
    icon: '💰',
    bgClass: 'bg-emerald-500/15',
    borderClass: 'border-emerald-500/25',
  },
  {
    name: 'Easy Winner',
    color: 'text-lime-400',
    description: 'Star-led limited run that recouped quickly',
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
    // Recouped, but only because the NY State theater tax credit pushed returns past 100% (owner 2026-10-29, BRO-6499).
    name: 'Squeaker',
    color: 'text-teal-400',
    description: 'Recouped, but only with the NY State tax credit; the Broadway run alone fell short',
    sortOrder: 5,
    showInLegend: true,
    icon: '😅',
    bgClass: 'bg-teal-500/15',
    borderClass: 'border-teal-500/25',
  },
  {
    name: 'TBD',
    color: 'text-gray-400',
    description: 'Too early to tell: still running or not open yet',
    sortOrder: 6,
    showInLegend: true,
    icon: '⏳',
    bgClass: 'bg-gray-500/15',
    borderClass: 'border-white/10',
  },
  {
    // Closed without recouping, never phrased as a loss (owner 2026-10-29, BRO-6499).
    name: 'Wait & See',
    color: 'text-amber-400',
    description: `Closed without recouping so far; ${WAIT_AND_SEE_MIN_RETURNED_PCT}% or more has come back and later income may still get it there`,
    sortOrder: 7,
    showInLegend: true,
    icon: '⏱️',
    bgClass: 'bg-amber-500/15',
    borderClass: 'border-amber-500/25',
  },
  {
    name: 'Fizzle',
    color: 'text-orange-400',
    description: `Closed without recouping; an estimated ${FIZZLE_MIN_RETURNED_PCT}% or more returned`,
    sortOrder: 8,
    showInLegend: true,
    icon: '📉',
    bgClass: 'bg-orange-500/15',
    borderClass: 'border-orange-500/25',
  },
  {
    // A loss with no estimate of its size (owner 2026-10-18, BRO-5636).
    name: 'Did Not Recoup',
    color: 'text-rose-300',
    description: 'Closed without recouping; no estimate of how much came back',
    sortOrder: 9,
    showInLegend: true,
    icon: '🔻',
    bgClass: 'bg-rose-500/15',
    borderClass: 'border-rose-500/25',
  },
  {
    name: 'Flop',
    color: 'text-red-400',
    description: `Closed without recouping; an estimated under ${FIZZLE_MIN_RETURNED_PCT}% returned`,
    sortOrder: 10,
    showInLegend: true,
    icon: '💸',
    bgClass: 'bg-red-500/15',
    borderClass: 'border-red-500/25',
  },
  {
    name: 'Nonprofit',
    color: 'text-blue-400',
    description: 'Nonprofit production (LCT, Roundabout, etc.)',
    sortOrder: 11,
    showInLegend: true,
    icon: '🎭',
    bgClass: 'bg-blue-500/15',
    borderClass: 'border-blue-500/25',
  },
  {
    name: 'Tour Stop',
    color: 'text-gray-400',
    description: 'National tour engagement on Broadway',
    sortOrder: 12,
    showInLegend: true,
    icon: '🚌',
    bgClass: 'bg-gray-500/15',
    borderClass: 'border-white/10',
  },
];

/**
 * Display-only label for a CLOSED show whose stored designation is still TBD:
 * the run is over but no outcome was announced. Never stored in
 * commercial.json (the record keeps TBD); see getDesignationDisplay in
 * src/lib/commercial-display.ts.
 */
export const UNDISCLOSED_DESIGNATION = {
  name: 'Undisclosed',
  color: 'text-gray-400',
  description: 'Closed; outcome not announced',
  icon: '❔',
  bgClass: 'bg-gray-500/15',
  borderClass: 'border-white/10',
} as const;

/**
 * Display-only label for a CLOSED TBD show that announced recoupment but not
 * the investor return (BRO-5020, The Piano Lesson). Recouped green, matching
 * the card's Recouped pill, so it never reads as an unknown outcome.
 */
export const RECOUPED_UNDISCLOSED_DESIGNATION = {
  name: 'Recouped · return undisclosed',
  color: 'text-emerald-400',
  description: 'Closed; recouped, investor return not announced',
  icon: '✅',
} as const;

/**
 * A TBD show's card text by status (BRO-5520: "Still running" printed for
 * shows not yet open). TBD's own description above covers every status for
 * the legend; a closed TBD is Undisclosed instead. See getDesignationDisplay.
 */
export const TBD_STATUS_DESCRIPTIONS = {
  open: 'Still running; too early to tell',
  previews: 'In previews; too early to tell',
  upcoming: 'Not open yet; too early to tell',
  announced: 'Not open yet; too early to tell',
} as const;

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
      borderClass: 'border-white/10',
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

/**
 * Legend rows for the /biz Designation Guide and the methodology page:
 * every legend designation plus the display-only "Undisclosed" and
 * "Recouped · return undisclosed" labels, placed right after TBD.
 */
export function getLegendEntries(): Array<{ name: string; color: string; description: string }> {
  const entries: Array<{ name: string; color: string; description: string }> = [];
  for (const d of getLegendDesignations()) {
    entries.push({ name: d.name, color: d.color, description: d.description });
    if (d.name === 'TBD') {
      entries.push({
        name: UNDISCLOSED_DESIGNATION.name,
        color: UNDISCLOSED_DESIGNATION.color,
        description: UNDISCLOSED_DESIGNATION.description,
      });
      entries.push({
        name: RECOUPED_UNDISCLOSED_DESIGNATION.name,
        color: RECOUPED_UNDISCLOSED_DESIGNATION.color,
        description: RECOUPED_UNDISCLOSED_DESIGNATION.description,
      });
    }
  }
  return entries;
}

// ============================================
// Trend config (also centralized)
// ============================================

export type RecoupmentTrend = 'improving' | 'declining' | 'steady' | 'unknown';

export function getTrendColor(trend: RecoupmentTrend, recouped: boolean | null): string {
  if (recouped) return 'text-fg-muted';
  switch (trend) {
    case 'improving': return 'text-emerald-400';
    case 'declining': return 'text-red-400';
    default: return 'text-fg-muted';
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

/**
 * Recouped shows whose recoupment was reported after closing but that we
 * estimate paid back during the run itself (owner decision 2026-10-20, BRO-5782).
 * Their weeks column shows opening night to closing, marked as our estimate,
 * instead of "Reported after closing". Add a slug only on the owner's say-so:
 * no source gives the recoupment date, so this is an editorial inference. The
 * value is the tooltip text, written per show because each rests on its own source.
 *  - purpose-2025: Broadway News (Jun 4 2026) says run profits plus the NY State
 *    tax credit earned back the $5.25M; nothing else paid it back. Its "about nine
 *    months after closing" is the gap to that report, not a sourced recoupment
 *    date (the show-page wording was corrected in data/pending-fixes/bro-5782.json).
 * Not for a show whose source credits other money (Kimberly Akimbo: tour profits).
 */
export const RECOUPED_DURING_RUN_ESTIMATE: Readonly<Record<string, string>> = {
  'purpose-2025':
    'Our estimate, not a reported figure. Broadway News says run profits plus the NY State tax credit earned back its capitalization, and no source dates the recoupment, so we count weeks from opening night to closing. The recoupment was reported after the run closed.',
};
