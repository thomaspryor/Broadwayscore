'use client';
/**
 * Shared building blocks for the web Stats modules (BRO-6170 prototype).
 *
 * Web re-expression of the iOS StatsPrimitives: surface tokens + .card, brand
 * gold as the ONLY chart hue (intensity via opacity on the same gold), score
 * tier colour only inside ScoreBadge. Every number is a button that opens its
 * drill-down ("every number is a door").
 */

import type { ReactNode } from 'react';

export function StatsCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card p-4 sm:p-5 min-w-0 ${className}`}>{children}</section>;
}

export function ModuleHeader({ title, caption, right }: { title: string; caption?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h3 className="text-base sm:text-lg font-bold text-white leading-tight">{title}</h3>
        {caption && <p className="text-xs text-gray-400 mt-1">{caption}</p>}
      </div>
      {right}
    </div>
  );
}

/** Small caps group label ("RISING MATCHES"). */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="text-xs font-bold uppercase tracking-wider text-fg-muted mb-2">{children}</p>;
}

const pressable =
  'text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60';

export function StatTile({
  value,
  label,
  sublabel,
  onClick,
  testId,
}: {
  value: string;
  label: string;
  sublabel?: string;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={`${value} ${label}. Opens the list.`}
      className={`${pressable} group rounded-xl bg-surface-overlay/70 hover:bg-surface-overlay border border-white/5 hover:border-white/10 px-3.5 py-3 sm:py-4 min-h-[88px] flex flex-col justify-center min-w-0`}
    >
      <span className="text-2xl sm:text-3xl font-extrabold text-white tabular-nums leading-tight truncate">{value}</span>
      <span className="text-xs text-gray-300 mt-1.5">{label}</span>
      {sublabel && <span className="text-xs text-fg-muted mt-0.5 truncate">{sublabel}</span>}
    </button>
  );
}

/** Label-over-value record pill that opens its shows. */
export function RecordPill({ label, value, onClick, testId }: { label: string; value: string; onClick?: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={!onClick}
      className={`${pressable} rounded-lg bg-surface-overlay/70 hover:bg-surface-overlay border border-white/5 hover:border-white/10 px-3 py-2 min-h-[44px] min-w-0`}
    >
      <span className="block text-xs text-fg-muted truncate">{label}</span>
      <span className="block text-sm font-semibold text-white tabular-nums truncate mt-0.5">{value}</span>
    </button>
  );
}

/** Horizontal progress track, single gold fill. */
export function GoldTrack({ pct, thick = false }: { pct: number; thick?: boolean }) {
  const clamped = Math.min(Math.max(pct, 0), 1);
  return (
    <div className={`w-full ${thick ? 'h-2.5' : 'h-2'} rounded-full bg-surface-overlay overflow-hidden`}>
      <div className="h-full rounded-full bg-brand" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/** Completion ring: overlay track + gold arc from 12 o'clock. */
export function ProgressRing({ pct, size = 104, stroke = 10, children }: { pct: number; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(pct, 0), 1);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="text-surface-overlay" stroke="currentColor" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * clamped} ${c}`}
          className="text-brand"
          stroke="currentColor"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

export function Chevron({ className = 'w-3.5 h-3.5 text-fg-muted' }: { className?: string }) {
  return (
    <svg className={`flex-shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** Rounded secondary chip button ("8 to see", "3 saw it before it won"). */
export function ChipButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`${pressable} inline-flex items-center gap-1.5 rounded-full bg-surface-overlay/70 hover:bg-surface-overlay border border-white/10 hover:border-white/20 px-3.5 min-h-[36px] text-xs font-semibold text-gray-200`}
    >
      {children}
      <Chevron className="w-3 h-3 text-fg-muted" />
    </button>
  );
}

/** Under-threshold placeholder for one module. */
export function ModuleLocked({ title, need, scopeLabel }: { title: string; need: string; scopeLabel?: string }) {
  return (
    <StatsCard>
      <ModuleHeader title={title} />
      <p className="text-sm text-gray-400">
        {need}
        {scopeLabel ? ` (${scopeLabel})` : ''}
      </p>
    </StatsCard>
  );
}

export const pressableClass = pressable;


/** Load state of one static data file behind a module. */
export type DataState = 'loading' | 'ready' | 'error';

/**
 * A module whose data file failed or timed out: says what is missing and
 * offers a retry, so one bad fetch never blanks the page or the other modules.
 */
export function ModuleError({ title, what, onRetry }: { title: string; what: string; onRetry: () => void }) {
  return (
    <StatsCard>
      <ModuleHeader title={title} />
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="stats-module-error">
        <p className="text-sm text-gray-400">Couldn&apos;t load {what}. Check your connection and try again.</p>
        <button type="button" onClick={onRetry} className="btn-secondary text-sm min-h-[44px]">
          Retry
        </button>
      </div>
    </StatsCard>
  );
}
