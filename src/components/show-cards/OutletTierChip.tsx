import { TIER_DISPLAY, tierBarsLit, type OutletTier } from '@/config/tier-display';

// The neutral gray outlet-tier chip (BRO-4881/4905). ReviewsList's interactive
// review-row chip and tier key build on TIER_CHIP_BOX + TierBars; outlet pages
// render OutletTierChip, so every T1-T4 label on the site looks the same (BRO-4885).
export const TIER_CHIP_BOX = 'inline-flex items-center gap-[3px] h-[18px] px-[5px] rounded border text-[10px] font-semibold leading-none tabular-nums tracking-[0.02em]';

/** Same chip, a few px narrower on phones, for the tier key row that must fit on one line. */
export const TIER_CHIP_BOX_TIGHT = `${TIER_CHIP_BOX} max-sm:gap-[2px] max-sm:px-1`;

/** Text color of the resting chip: Tier 1 a touch brighter, the rest gray. */
export function tierChipTextClass(tier: OutletTier): string {
  return tier === 1 ? 'text-gray-300' : 'text-fg-muted';
}

// Four ascending bars, lit one per step of weight (T1 all four, T4 one), so the
// chip shows how much a review counts and not only which tier it is (BRO-4905).
export function TierBars({ tier, className = '' }: { tier: OutletTier; className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[1.5px] h-[9px] ${className}`} aria-hidden="true" data-testid="tier-bars">
      {[3, 5, 7, 9].map((h, i) => (
        <span key={h} className={`w-[2px] rounded-[1px] ${i < tierBarsLit(tier) ? 'bg-current' : 'bg-white/[0.14]'}`} style={{ height: h }} />
      ))}
    </span>
  );
}

/** Static (non-interactive) tier chip for outlet pages. */
export function OutletTierChip({ tier }: { tier: OutletTier }) {
  const info = TIER_DISPLAY[tier];
  const label = `Tier ${tier}: ${info.title}. ${info.relative}`;
  return (
    <span
      className={`${TIER_CHIP_BOX} flex-shrink-0 border-white/[0.12] ${tierChipTextClass(tier)}`}
      title={label}
      data-testid="outlet-tier-chip"
    >
      <span aria-hidden="true">T{tier}</span>
      <TierBars tier={tier} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
