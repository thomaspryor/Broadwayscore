import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

const BADGE_LABEL: Record<TierBadge, { label: string; inProgressLabel?: string; tone: string; ring: string }> = {
  sweeper:        { label: 'Sweeper',        tone: 'text-amber-300',  ring: 'ring-amber-400/30 bg-gradient-to-br from-amber-500/20 to-yellow-500/10' },
  decorated:      { label: 'Decorated',      tone: 'text-violet-300', ring: 'ring-violet-400/30 bg-violet-500/10' },
  honored:        { label: 'Honored',        tone: 'text-emerald-300', ring: 'ring-emerald-400/25 bg-emerald-500/10' },
  nominated:      { label: 'Nominated',      inProgressLabel: 'In the Hunt', tone: 'text-sky-300', ring: 'ring-sky-400/25 bg-sky-500/10' },
  'in-the-hunt':  { label: 'In the Hunt',    tone: 'text-sky-300',     ring: 'ring-sky-400/25 bg-sky-500/10' },
  eligible:       { label: 'Eligible',       tone: 'text-gray-400',    ring: 'ring-white/10 bg-surface-overlay' },
};

export function AwardScoreBadge({ score, badge, inProgress, size = 'md' }: AwardScoreBadgeProps) {
  const cfg = BADGE_LABEL[badge];
  const label = inProgress && cfg.inProgressLabel ? cfg.inProgressLabel : cfg.label;
  const numClass = size === 'lg' ? 'text-5xl' : 'text-4xl';

  return (
    <div className="flex items-center gap-4">
      <div className={`relative flex items-center justify-center rounded-2xl ring-1 px-5 py-3 ${cfg.ring}`}>
        <span className={`font-bold tabular-nums ${numClass} ${cfg.tone}`}>{score}</span>
        {inProgress && (
          <span aria-hidden className={`absolute -top-1 -right-1 ${cfg.tone} text-xl font-bold`}>*</span>
        )}
      </div>
      <div>
        <div className={`text-lg font-bold uppercase tracking-wide ${cfg.tone}`}>{label}</div>
        <div className="text-xs text-gray-400 uppercase tracking-wide">Award Score</div>
        {inProgress && (
          <div className="text-xs text-gray-500 mt-1">*Score so far — season in progress</div>
        )}
      </div>
    </div>
  );
}
