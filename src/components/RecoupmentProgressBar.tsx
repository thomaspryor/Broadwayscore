'use client';

interface RecoupmentProgressBarProps {
  /** AI estimate [low, high] or model [pessimistic, central, optimistic] */
  estimatedPct: [number, number] | [number, number, number];
  source?: string | null;
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
}

function getBarColor(value: number): string {
  if (value > 70) return 'from-emerald-500 to-emerald-400';
  if (value >= 40) return 'from-yellow-500 to-yellow-400';
  return 'from-orange-500 to-red-400';
}

const METHOD_LABELS: Record<string, string> = {
  'weekly-model': 'Model-calculated',
  'simplified-lifetime': 'Lifetime estimate',
  'ai-estimated': 'AI-estimated',
};

export default function RecoupmentProgressBar({ estimatedPct, source, modelMethod }: RecoupmentProgressBarProps) {
  const isModel = estimatedPct.length === 3;
  const low = Math.round(Math.min(...estimatedPct));
  const high = Math.round(Math.max(...estimatedPct));
  const central = isModel ? Math.round(estimatedPct[1]) : Math.round((low + high) / 2);

  const barColor = getBarColor(central);
  const barWidth = Math.min(Math.max(central, 0), 100); // Clamp 0-100 for display

  const label = isModel
    ? `${central}% recouped`
    : (low === high ? `~${low}% recouped` : `~${low}-${high}% recouped`);

  const methodLabel = modelMethod ? METHOD_LABELS[modelMethod] : null;

  return (
    <div data-testid="recoupment-progress" className="mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-400">{label}</span>
        {isModel && low !== high && (
          <span className="text-[10px] text-gray-500">Range: {low}–{high}%</span>
        )}
      </div>
      <div className="relative w-full bg-surface-overlay/50 rounded-full h-2.5">
        {/* Main bar at central estimate */}
        <div
          role="progressbar"
          aria-valuenow={central}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Estimated ${central} percent recouped (range ${low} to ${high})`}
          className={`h-2.5 rounded-full bg-gradient-to-r ${barColor} transition-all`}
          style={{ width: `${barWidth}%` }}
        />
        {/* Range indicator for model data */}
        {isModel && low !== high && low >= 0 && high <= 100 && (
          <div
            className="absolute top-0 h-2.5 border-l border-r border-white/30 rounded-full"
            style={{ left: `${Math.max(low, 0)}%`, width: `${Math.min(high, 100) - Math.max(low, 0)}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between mt-1">
        {(source || methodLabel) && (
          <p className="text-[10px] text-gray-500">
            {methodLabel && <span className="text-gray-400">{methodLabel}</span>}
            {methodLabel && source && ' · '}
            {source && `Source: ${source}`}
          </p>
        )}
      </div>
    </div>
  );
}
