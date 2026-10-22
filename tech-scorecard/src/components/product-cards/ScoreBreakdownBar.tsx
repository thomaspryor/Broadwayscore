import { BREAKDOWN_LABELS, TIER_ORDER, type TierKey } from '@/config/score-buckets';

export function ScoreBreakdownBar({ breakdown }: { breakdown: Record<TierKey, number> }) {
  const total = TIER_ORDER.reduce((n, k) => n + breakdown[k], 0);
  if (total === 0) return null;
  const present = TIER_ORDER.filter((k) => breakdown[k] > 0);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-overlay" role="img"
        aria-label={present.map((k) => `${breakdown[k]} ${BREAKDOWN_LABELS[k].label}`).join(', ')}>
        {present.map((k) => (
          <div key={k} style={{ width: `${(breakdown[k] / total) * 100}%`, backgroundColor: BREAKDOWN_LABELS[k].color }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-ink-muted">
        {present.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: BREAKDOWN_LABELS[k].color }} />
            {breakdown[k]} {BREAKDOWN_LABELS[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}
