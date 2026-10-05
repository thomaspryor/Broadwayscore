'use client';

import { getModelRecoupmentLabels } from '@/lib/commercial-display';

interface RecoupmentProgressBarProps {
  /** Model output [pessimistic, central, optimistic] (legacy [low, high] AI shape still supported) */
  estimatedPct: [number, number] | [number, number, number];
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  /**
   * 'compact' (default): small inline label + bar, used in the /biz table.
   * 'headline': show-page card treatment per the approved mockup: uppercase
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
  'weekly-model': 'Model estimate',
  'simplified-lifetime': 'Lifetime model estimate',
  'ai-estimated': 'AI-estimated',
};

// BRO-4623: the old ">= 200% → '~Nx returned to investors'" regime is gone.
// The model's percentage is of capitalization net of SVOG grants plus a
// reserve, not what investors put in, so it is not an investor return
// (Hamilton read "~159x"). Above 100% we say "100%+" and stop there; labels
// come from getModelRecoupmentLabels (unit-tested in
// tests/unit/recoupment-progress-label.test.mjs).
export default function RecoupmentProgressBar({ estimatedPct, modelMethod, variant = 'compact' }: RecoupmentProgressBarProps) {
  const labels = getModelRecoupmentLabels(estimatedPct);
  const { low, central, high, valueText, label, rangeLabel, ariaLabel, barWidth } = labels;
  const isModel = estimatedPct.length === 3;
  const barColor = getBarColor(central);
  const methodLabel = modelMethod ? METHOD_LABELS[modelMethod] : null;

  if (variant === 'headline') {
    return (
      <div data-testid="recoupment-progress" className="mt-1">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
            Est. recoupment
          </span>
          <span className="text-[22px] leading-none font-extrabold tracking-tight text-brand-light tabular-nums">
            {/* "~" like every other estimate on the card ("~ marks an estimate") and the /biz cards. */}
            ~{valueText}
          </span>
        </div>
        <div className="relative w-full bg-surface-overlay/50 rounded-full h-1.5">
          <div
            role="progressbar"
            aria-valuenow={barWidth}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={ariaLabel}
            className={`h-1.5 rounded-full bg-gradient-to-r ${barColor} transition-all`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
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
      <div className="relative w-full bg-surface-overlay/50 rounded-full h-2.5">
        {/* Main bar at central estimate */}
        <div
          role="progressbar"
          aria-valuenow={barWidth}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={ariaLabel}
          className={`h-2.5 rounded-full bg-gradient-to-r ${barColor} transition-all`}
          style={{ width: `${barWidth}%` }}
        />
        {/* Range indicator for model data */}
        {isModel && low !== high && high <= 100 && (
          <div
            className="absolute top-0 h-2.5 border-l border-r border-white/30 rounded-full"
            style={{ left: `${low}%`, width: `${high - low}%` }}
          />
        )}
      </div>
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
