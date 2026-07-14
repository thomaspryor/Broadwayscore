// Shared currency formatting for the /biz Investment Tracker.
// Single source of truth so a missing data point renders "—" everywhere
// instead of drifting per-component (the null → "~$0" credibility bug).

/** "$1.2M" / "$450K" / "$800" style formatting. "—" for null/undefined. */
export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs}`;
}

/**
 * For figures that are always estimates when present (capitalization, break-even).
 * Prefixes with "~" — but only when there's a real number to estimate. A missing
 * value renders bare "—", never "~—".
 */
export function formatEstimatedCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return `~${formatCurrency(amount)}`;
}
