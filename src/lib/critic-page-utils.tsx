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

