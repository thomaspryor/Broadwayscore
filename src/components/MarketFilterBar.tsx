'use client';

import Link from 'next/link';

type MarketKey = 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end';
type TypeValue = 'all' | 'musical' | 'play' | 'opera';

interface MarketFilterBarProps {
  /** Which pair of markets to render: NYC (Broadway + Off-Bway) or London (West End + Off-WE) */
  pair: 'nyc' | 'london';
  /** Which market in the pair is currently active (the page we're on) */
  activeMarket: MarketKey;
  /** Count shown next to the primary pill */
  primaryCount: number;
  /** Count shown next to the secondary pill */
  secondaryCount: number;
  /** Current type filter value */
  typeValue: TypeValue;
  /** Type-filter change handler */
  onTypeChange: (t: TypeValue) => void;
  /**
   * Homepage only: split the NYC primary pill into Broadway+ / Bway only
   * buttons (client-side filter over the curated OB picks mixed into the
   * grid). When absent, the primary renders as a single nav Link.
   */
  broadwayMode?: 'plus' | 'only';
  onBroadwayModeChange?: (m: 'plus' | 'only') => void;
  /** Count for the Bway-only pill when the primary is split */
  broadwayOnlyCount?: number;
  className?: string;
}

const TYPE_OPTIONS: { value: TypeValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'musical', label: 'Musicals' },
  { value: 'play', label: 'Plays' },
];

export default function MarketFilterBar({
  pair,
  activeMarket,
  primaryCount,
  secondaryCount,
  typeValue,
  onTypeChange,
  broadwayMode,
  onBroadwayModeChange,
  broadwayOnlyCount,
  className,
}: MarketFilterBarProps) {
  const isNyc = pair === 'nyc';
  // "Broadway+" because the homepage grid mixes in curated Off-Broadway picks
  const primary = isNyc
    ? { label: 'Broadway+', href: '/', key: 'broadway' as MarketKey }
    : { label: 'West End', href: '/west-end', key: 'west-end' as MarketKey };
  const secondary = isNyc
    ? { label: 'Off-Bway', href: '/off-broadway', key: 'off-broadway' as MarketKey }
    : { label: 'Off-WE', href: '/off-west-end', key: 'off-west-end' as MarketKey };

  const primaryActive = activeMarket === primary.key;
  const secondaryActive = activeMarket === secondary.key;

  const secondaryAccent = isNyc ? 'purple' : 'violet';

  const pillBase =
    'min-h-[44px] sm:min-h-0 px-3 py-2.5 sm:py-2 rounded-full text-xs sm:text-sm font-semibold leading-none inline-flex items-center gap-1.5 transition-all whitespace-nowrap';

  const primaryActiveClass = isNyc
    ? 'bg-brand text-gray-900 shadow-glow-sm font-bold'
    : 'bg-gradient-to-r from-pink-400 to-pink-500 text-gray-900 shadow-[0_0_12px_rgba(244,114,182,0.25)] font-bold';
  const primaryIdleClass =
    'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20';

  const secondaryActiveClass =
    secondaryAccent === 'purple'
      ? 'bg-purple-500/[0.12] border border-purple-500/25 text-purple-200 font-bold'
      : 'bg-violet-500/[0.12] border border-violet-500/25 text-violet-200 font-bold';
  const secondaryIdleClass =
    'bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:text-gray-200';

  const typeActiveClass = 'bg-white/[0.12] text-white border border-white/20';
  const typeIdleClass =
    'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20';

  const dotActiveClass =
    secondaryAccent === 'purple'
      ? 'bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.5)]'
      : 'bg-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.5)]';

  const countClass = (active: boolean, accent: 'dark' | 'purple' | 'violet' | 'gray') => {
    if (active && accent === 'dark') return 'text-gray-800/70';
    if (active && accent === 'purple') return 'text-purple-300/70';
    if (active && accent === 'violet') return 'text-violet-300/70';
    return 'text-gray-500';
  };

  return (
    <div
      role="group"
      aria-label="Market and type filters"
      className={`flex items-center gap-1.5 overflow-x-auto flex-nowrap scrollbar-hide min-w-0 flex-1 [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent_100%)] sm:[mask-image:none] ${className ?? ''}`}
    >
      {/* Primary market pill — split into Broadway+ / Bway only on the homepage */}
      {isNyc && broadwayMode ? (
        <>
          {/* No counts on the split buttons — the row is at width capacity and
              they're a view toggle (like CRITICS/AUDIENCE), not a nav pill */}
          <button
            onClick={() => onBroadwayModeChange?.('plus')}
            aria-pressed={broadwayMode === 'plus'}
            title={`Broadway plus notable Off-Broadway picks (${primaryCount})`}
            className={`${pillBase} flex-shrink-0 ${broadwayMode === 'plus' ? primaryActiveClass : primaryIdleClass}`}
          >
            Broadway+
          </button>
          <button
            onClick={() => onBroadwayModeChange?.('only')}
            aria-pressed={broadwayMode === 'only'}
            title={`Broadway shows only (${broadwayOnlyCount ?? primaryCount})`}
            className={`${pillBase} flex-shrink-0 ${broadwayMode === 'only' ? primaryActiveClass : primaryIdleClass}`}
          >
            Bway only
          </button>
        </>
      ) : (
        <Link
          href={primary.href}
          aria-current={primaryActive ? 'page' : undefined}
          className={`${pillBase} flex-shrink-0 ${primaryActive ? primaryActiveClass : primaryIdleClass}`}
        >
          {primary.label}
          <span className={`text-[10px] font-medium tabular-nums ${countClass(primaryActive, 'dark')}`}>
            {primaryCount}
          </span>
        </Link>
      )}

      {/* Secondary market pill — in split mode it joins the three-pill filter
          group, so the dot + count come off to keep the row inside its width
          budget (count stays available in the tooltip) */}
      <Link
        href={secondary.href}
        aria-current={secondaryActive ? 'page' : undefined}
        title={isNyc && broadwayMode ? `${secondary.label} (${secondaryCount})` : undefined}
        className={`${pillBase} flex-shrink-0 ${secondaryActive ? secondaryActiveClass : secondaryIdleClass}`}
      >
        {!(isNyc && broadwayMode) && (
          <span
            className={`w-1.5 h-1.5 rounded-full ${secondaryActive ? dotActiveClass : 'bg-gray-600'}`}
            aria-hidden="true"
          />
        )}
        {secondary.label}
        {!(isNyc && broadwayMode) && (
          <span className={`text-[10px] font-medium tabular-nums ${countClass(secondaryActive, secondaryAccent)}`}>
            {secondaryCount}
          </span>
        )}
      </Link>

      {/* Divider */}
      <div className="w-px h-5 bg-white/10 flex-shrink-0 mx-0.5" aria-hidden="true" />

      {/* Type filter pills */}
      <div
        className="flex items-center gap-2 flex-shrink-0"
        role="group"
        aria-label="Filter by show type"
      >
        {TYPE_OPTIONS.map((option) => {
          const active = typeValue === option.value;
          return (
            <button
              key={option.value}
              onClick={() => onTypeChange(option.value)}
              aria-pressed={active}
              className={`${pillBase} justify-center ${active ? typeActiveClass : typeIdleClass}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
