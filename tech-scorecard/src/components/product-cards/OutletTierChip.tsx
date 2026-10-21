import { TIER_WEIGHTS } from '@/config/scoring';

/** "T1 ▂▄▆█" chip, same idea as Broadway Scorecard's OutletTierChip. */
export function OutletTierChip({ tier }: { tier: 1 | 2 | 3 | 4 }) {
  const bars = 5 - tier;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-[1px] text-[10px] font-bold text-ink-muted"
      title={`Tier ${tier} outlet, weighted ${Math.round(TIER_WEIGHTS[tier] * 100)}%`}>
      T{tier}
      <span className="flex items-end gap-[1.5px]" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`w-[2px] rounded-[1px] ${i <= bars ? 'bg-ink-muted' : 'bg-line-strong'}`} style={{ height: 2 + i * 2 }} />
        ))}
      </span>
    </span>
  );
}
