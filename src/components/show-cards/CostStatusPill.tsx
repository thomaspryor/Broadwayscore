import type { CostPill } from '@/lib/box-office-v2-display';

const TONE_CLASS: Record<CostPill['tone'], string> = {
  above: 'chip bg-status-open-bg text-status-open border border-white/10',
  near: 'chip bg-status-closed-bg text-gray-300 border border-white/10',
  below: 'chip bg-score-tepid-bg text-score-tepid border border-white/10',
  muted: 'chip bg-status-closed-bg text-gray-400 border border-white/10',
  pending: 'inline-flex items-center px-3 py-1 rounded-pill text-sm font-bold text-gray-400 bg-white/5 border border-dashed border-white/25',
};

/** Box Office Scorecard v2 status: gross versus weekly cost (Above / Near / Below Cost, Too early, ...). */
export function CostStatusPill({ pill }: { pill: CostPill }) {
  return <span className={TONE_CLASS[pill.tone]}>{pill.label}</span>;
}
