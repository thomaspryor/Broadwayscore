/**
 * Gold List Badge — branded gold metallic shimmer icon
 * Replaces emoji icons with Star (critics), A+ (audience), Flame (hot ticket), $ (box office)
 */

import type { GoldListType } from '@/config/gold-lists';

type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

const SVG_SIZES: Record<BadgeSize, string> = {
  xs: 'w-[10px] h-[10px]',
  sm: 'w-3 h-3',
  md: 'w-5 h-5',
  lg: 'w-7 h-7',
};

const TEXT_SIZES: Record<BadgeSize, { aplus: string; dollar: string }> = {
  xs: { aplus: 'text-[9px]', dollar: 'text-[10px]' },
  sm: { aplus: 'text-[11px]', dollar: 'text-[12px]' },
  md: { aplus: 'text-[20px]', dollar: 'text-[22px]' },
  lg: { aplus: 'text-[28px]', dollar: 'text-[30px]' },
};

function StarIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`relative z-[1] fill-[#1a1a1a] ${className}`}>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z" />
    </svg>
  );
}

function FlameIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`relative z-[1] fill-[#1a1a1a] ${className}`}>
      <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" />
    </svg>
  );
}

export function GoldListBadge({ type, size = 'sm' }: { type: GoldListType; size?: BadgeSize }) {
  const svgSize = SVG_SIZES[size];
  const ts = TEXT_SIZES[size];

  const icon = (() => {
    switch (type) {
      case 'critical-gold':
      case 'critical-gold-west-end':
      case 'critical-gold-off-broadway':
      case 'critical-gold-off-west-end':
        return <StarIcon className={svgSize} />;
      case 'audience-gold':
        return (
          <span className={`${ts.aplus} font-black text-[#1a1a1a] relative z-[1] leading-none tracking-tight`}>
            A<sup className="text-[0.5em] font-black leading-none">+</sup>
          </span>
        );
      case 'hot-ticket-gold':
        return <FlameIcon className={svgSize} />;
      case 'box-office-gold':
        return (
          <span className={`${ts.dollar} font-black text-[#1a1a1a] relative z-[1] leading-none`}>
            $
          </span>
        );
    }
  })();

  return (
    <span className={`gold-badge gold-badge-${size}`} aria-hidden="true">
      {icon}
    </span>
  );
}
