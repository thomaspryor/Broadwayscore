'use client';

interface RecoupmentProgressBarProps {
  /** Model output [pessimistic, central, optimistic] (legacy [low, high] AI shape still supported) */
  estimatedPct: [number, number] | [number, number, number];
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  /**
   * 'compact' (default): small inline label + bar, used in the /biz table.
   * 'headline': show-page card treatment per the approved mockup — uppercase
   * "Est. recoupment" label with the percentage as a large brand-toned number.
   */
  variant?: 'compact' | 'headline';
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

// Threshold above which we swap "% recouped" for an "Nx returned" multiple.
// At 100% a show has JUST recouped; a clamped-full bar communicates that fine.
// Above ~200% (2x) the raw percentage becomes absurd (Hamilton = ~15,926%) and
// the multiple is the meaningful headline. See task #41.
const MULTIPLE_THRESHOLD_PCT = 200;

function formatMultiple(pct: number): string {
  return `${(pct / 100).toFixed(1)}x`;
}

export default function RecoupmentProgressBar({ estimatedPct, modelMethod, variant = 'compact' }: RecoupmentProgressBarProps) {
  const isModel = estimatedPct.length === 3;
  // Clamp at 0: the model can emit negative percentages for deep flops
  // (e.g. cabaret-2024 [-168, -120, -74]); "-120% recouped" is nonsense copy.
  const low = Math.max(0, Math.round(Math.min(...estimatedPct)));
  const high = Math.max(0, Math.round(Math.max(...estimatedPct)));
  const central = Math.max(0, isModel ? Math.round(estimatedPct[1]) : Math.round((low + high) / 2));

  // Recouped long-runners: swap "N% recouped" for "Nx returned to investors"
  // and hide the (meaningless past 100%) progress bar.
  const asMultiple = central >= MULTIPLE_THRESHOLD_PCT;

  const barColor = getBarColor(central);
  const barWidth = Math.min(Math.max(central, 0), 100); // Clamp 0-100 for display

  let label: string;
  let rangeLabel: string | null = null;
  if (asMultiple) {
    label = `~${formatMultiple(central)} returned to investors`;
    if (isModel && low !== high) {
      rangeLabel = `Range: ${formatMultiple(low)}–${formatMultiple(high)}`;
    }
  } else if (isModel) {
    label = `${central}% recouped`;
    if (low !== high) rangeLabel = `Range: ${low}–${high}%`;
  } else {
    label = low === high ? `~${low}% recouped` : `~${low}-${high}% recouped`;
  }

  const methodLabel = modelMethod ? METHOD_LABELS[modelMethod] : null;

  const ariaLabel = asMultiple
    ? `Estimated ${formatMultiple(central)} returned to investors (range ${formatMultiple(low)} to ${formatMultiple(high)})`
    : `Estimated ${central} percent recouped (range ${low} to ${high})`;

  if (variant === 'headline') {
    const headlineValue = asMultiple ? `~${formatMultiple(central)}` : `${central}%`;
    return (
      <div data-testid="recoupment-progress" className="mt-1">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
            {asMultiple ? 'Est. return to investors' : 'Est. recoupment'}
          </span>
          <span className="text-[22px] leading-none font-extrabold tracking-tight text-brand-light tabular-nums">
            {headlineValue}
          </span>
        </div>
        {!asMultiple && (
          <div className="relative w-full bg-surface-overlay/50 rounded-full h-1.5">
            <div
              role="progressbar"
              aria-valuenow={central}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={ariaLabel}
              className={`h-1.5 rounded-full bg-gradient-to-r ${barColor} transition-all`}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        )}
        <div className="flex items-center justify-between mt-1.5">
          {rangeLabel && <span className="text-[10px] text-gray-500">{rangeLabel}</span>}
          {methodLabel && <span className="text-[10px] text-gray-400">{methodLabel}</span>}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="recoupment-progress" className="mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-400">{label}</span>
        {rangeLabel && (
          <span className="text-[10px] text-gray-500">{rangeLabel}</span>
        )}
      </div>
      {!asMultiple && (
        <div className="relative w-full bg-surface-overlay/50 rounded-full h-2.5">
          {/* Main bar at central estimate */}
          <div
            role="progressbar"
            aria-valuenow={central}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={ariaLabel}
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
      )}
      <div className="flex items-center justify-between mt-1">
        {methodLabel && (
          <p className="text-[10px] text-gray-500">
            <span className="text-gray-400">{methodLabel}</span>
          </p>
        )}
      </div>
    </div>
  );
}
