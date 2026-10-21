import type { Sentiment } from '@/config/score-buckets';

const SEGMENTS: { key: Sentiment; label: string; color: string }[] = [
  { key: 'rave', label: 'Rave', color: '#f5c518' },
  { key: 'positive', label: 'Positive', color: '#22c55e' },
  { key: 'mixed', label: 'Mixed', color: '#f59e0b' },
  { key: 'negative', label: 'Negative', color: '#ef4444' },
];

export function ScoreBreakdownBar({ breakdown }: { breakdown: Record<Sentiment, number> }) {
  const total = SEGMENTS.reduce((n, s) => n + breakdown[s.key], 0);
  if (total === 0) return null;
  const present = SEGMENTS.filter((s) => breakdown[s.key] > 0);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-overlay" role="img"
        aria-label={present.map((s) => `${breakdown[s.key]} ${s.label}`).join(', ')}>
        {present.map((s) => (
          <div key={s.key} style={{ width: `${(breakdown[s.key] / total) * 100}%`, backgroundColor: s.color }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-ink-muted">
        {present.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
            {breakdown[s.key]} {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
