// Shared utilities for critic & outlet page client components
// Pure functions + small UI components — no server-only imports

import { getScoreColorClass as _getScoreColorClass, getScoreTier } from '@/components/show-cards';

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function getScoreClass(score: number, category?: string): string {
  return _getScoreColorClass(score, category);
}

export function getScoreTextColor(score: number, category?: string): string {
  return getScoreTier(score, category)?.color ?? '#ef4444';
}

export function formatDate(parsedDate: number | null): string {
  if (!parsedDate) return '';
  return new Date(parsedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TierBadge({ tier }: { tier: 1 | 2 | 3 | 4 }) {
  const cls = tier === 1
    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    : tier === 2
    ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-400 border-white/15';
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${cls}`}>
      Tier {tier}
    </span>
  );
}

export function TierBadgeSmall({ tier }: { tier: 1 | 2 | 3 | 4 }) {
  const cls = tier === 1
    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    : tier === 2
    ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-400 border-white/15';
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cls}`}>
      T{tier}
    </span>
  );
}
