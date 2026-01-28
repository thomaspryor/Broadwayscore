'use client';

interface RecoupmentProgressBarProps {
  estimatedPct: [number, number];
  source?: string | null;
}

function getBarColor(midpoint: number): string {
  if (midpoint > 70) return 'from-emerald-500 to-emerald-400';
  if (midpoint >= 40) return 'from-yellow-500 to-yellow-400';
  return 'from-orange-500 to-red-400';
}

export default function RecoupmentProgressBar({ estimatedPct, source }: RecoupmentProgressBarProps) {
  let [low, high] = estimatedPct;
  if (low > high) [low, high] = [high, low];

  const midpoint = Math.round((low + high) / 2);
  const barColor = getBarColor(midpoint);
  const label = low === high
    ? `~${low}% recouped`
    : `~${low}-${high}% recouped`;

  return (
    <div data-testid="recoupment-progress" className="mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-400">{label}</span>
      </div>
      <div className="w-full bg-gray-700/50 rounded-full h-2.5">
        <div
          role="progressbar"
          aria-valuenow={midpoint}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Estimated ${low} to ${high} percent recouped`}
          className={`h-2.5 rounded-full bg-gradient-to-r ${barColor} transition-all`}
          style={{ width: `${midpoint}%` }}
        />
      </div>
      {source && (
        <p className="text-[10px] text-gray-600 mt-1">Source: {source}</p>
      )}
    </div>
  );
}
