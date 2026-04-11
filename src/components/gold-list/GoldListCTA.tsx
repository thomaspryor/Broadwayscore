import Link from 'next/link';
import { GoldListBadge } from './GoldListBadge';
import type { GoldListType } from '@/config/gold-lists';

/**
 * Compact link card promoting the Critical Gold List for a specific market.
 * Rendered on the /west-end, /off-broadway, /off-west-end landing pages so
 * users can discover the gold lists (previously only reachable via /lists).
 */
export function GoldListCTA({ listType }: { listType: GoldListType }) {
  // Map each market list type to its display strings + accent classes.
  // Keeping this inline rather than reading GOLD_LIST_MAP because the CTA
  // copy is shorter than the full list description.
  const config: Record<GoldListType, { label: string; tagline: string; bg: string; border: string; text: string } | null> = {
    'critical-gold': {
      label: 'Critical Gold List™',
      tagline: 'The best of Broadway by critics',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/30',
      text: 'text-amber-400',
    },
    'critical-gold-west-end': {
      label: 'West End Critical Gold List™',
      tagline: 'The best of the West End by critics',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/30',
      text: 'text-sky-400',
    },
    'critical-gold-off-broadway': {
      label: 'Off-Broadway Critical Gold List™',
      tagline: 'The best of Off-Broadway by critics',
      bg: 'bg-teal-500/10',
      border: 'border-teal-500/30',
      text: 'text-teal-400',
    },
    'critical-gold-off-west-end': {
      label: 'Off-West End Critical Gold List™',
      tagline: 'The best of Off-West End by critics',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/30',
      text: 'text-indigo-400',
    },
    // Non-critic lists reuse this component too if anyone ever wants to
    // surface them on market landing pages. Currently unused.
    'audience-gold': null,
    'box-office-gold': null,
    'hot-ticket-gold': null,
  };

  const c = config[listType];
  if (!c) return null;

  return (
    <Link
      href={`/lists/${listType}/all-time`}
      className={`group flex items-center gap-3 rounded-xl border ${c.border} ${c.bg} px-4 py-3 mb-4 sm:mb-6 transition-colors hover:bg-white/5`}
    >
      <GoldListBadge type={listType} size="md" />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-bold ${c.text} leading-tight`}>
          {c.label}
        </div>
        <div className="text-xs text-gray-400 mt-0.5 leading-tight">
          {c.tagline}
        </div>
      </div>
      <svg
        className="w-4 h-4 text-gray-400 group-hover:text-white flex-shrink-0 transition-colors"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}
