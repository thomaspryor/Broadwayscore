/**
 * Shared formatting utilities used across biz/commercial components.
 */

export type SortDirection = 'asc' | 'desc';

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '\u2014';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

export function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '\u2014';
  return num.toLocaleString();
}

export function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '\u2014';
  return `${pct.toFixed(1)}%`;
}
