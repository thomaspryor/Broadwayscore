// Shared currency formatting for the /biz Investment Tracker.
// Single source of truth so a missing data point renders "—" everywhere
// instead of drifting per-component (the null → "~$0" credibility bug).
//
// Re-exports the app-wide formatCurrency from @/lib/formatting rather than
// reimplementing it — the /biz components previously each had their own
// ad-hoc copy; this file was almost a third fork of the same K/M/B logic.

import { formatCurrency } from './formatting';
export { formatCurrency };

/**
 * For figures that are always estimates when present (capitalization, break-even).
 * Prefixes with "~" — but only when there's a real number to estimate. A missing
 * value renders bare "—", never "~—".
 */
export function formatEstimatedCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return `~${formatCurrency(amount)}`;
}
