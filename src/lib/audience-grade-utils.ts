// Pure audience grade utility functions — ZERO JSON imports.
// Safe for 'use client' components. See data-audience.ts for data-fetching functions.

import type { AudienceBuzzData } from './data-types';

/**
 * Minimum total audience reviews required to display a grade.
 * Shows with fewer reviews get no grade (too unreliable).
 */
export const MIN_AUDIENCE_REVIEWS = 15;

/**
 * Get total audience review count across all sources.
 */
export function getTotalAudienceReviews(buzz: AudienceBuzzData): number {
  if (!buzz.sources) return 0;
  return Object.values(buzz.sources).reduce(
    (sum, source) => sum + (source?.reviewCount ?? 0),
    0
  );
}

/**
 * Check if a show has enough audience reviews to display a grade.
 */
export function hasEnoughAudienceReviews(buzz: AudienceBuzzData): boolean {
  return getTotalAudienceReviews(buzz) >= MIN_AUDIENCE_REVIEWS;
}

/**
 * Compute audience letter grade from combinedScore.
 * Grade scale shifted down 2 points from standard academic.
 * Colors use solid fills matching the critic score badge style.
 */
export function getAudienceGrade(score: number | null | undefined): {
  grade: string;
  label: string;
  color: string;
  textColor: string;
  tooltip: string;
} {
  if (score == null) return { grade: '—', label: 'No Data', color: '#6b7280', textColor: '#ffffff', tooltip: 'No audience data available' };
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#ffffff', tooltip: 'Audiences love it' };
  if (score >= 88) return { grade: 'A', label: 'Loving It', color: '#16a34a', textColor: '#ffffff', tooltip: 'Audiences love it' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#ffffff', tooltip: 'Strong audience reception' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#ffffff', tooltip: 'Solid audience reception' };
  if (score >= 73) return { grade: 'B', label: 'Shrugging', color: '#f59e0b', textColor: '#1a1a1a', tooltip: 'Mixed-positive reception' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#1a1a1a', tooltip: 'Mixed audience reception' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking It', color: '#ef4444', textColor: '#ffffff', tooltip: 'Below-average reception' };
  if (score >= 58) return { grade: 'C', label: 'Disliking It', color: '#dc2626', textColor: '#ffffff', tooltip: 'Weak audience reception' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking It', color: '#b91c1c', textColor: '#ffffff', tooltip: 'Poor audience reception' };
  if (score >= 48) return { grade: 'D', label: 'Loathing It', color: '#991b1b', textColor: '#ffffff', tooltip: 'Very poor reception' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#ffffff', tooltip: 'Audiences dislike it' };
}

/**
 * Get Tailwind classes for an audience grade badge (used in AudienceBuzzCard).
 */
export function getAudienceGradeClasses(score: number | null | undefined): {
  bgClass: string;
  textClass: string;
  borderClass: string;
} {
  const { grade } = getAudienceGrade(score);
  if (grade.startsWith('A')) return { bgClass: 'bg-green-500/15', textClass: 'text-green-400', borderClass: 'border-green-500/25' };
  if (grade === 'B+') return { bgClass: 'bg-sky-500/15', textClass: 'text-sky-400', borderClass: 'border-sky-500/25' };
  if (grade === 'B') return { bgClass: 'bg-amber-500/15', textClass: 'text-amber-400', borderClass: 'border-amber-500/25' };
  if (grade === 'B-') return { bgClass: 'bg-orange-500/15', textClass: 'text-orange-400', borderClass: 'border-orange-500/25' };
  if (grade.startsWith('C')) return { bgClass: 'bg-red-500/15', textClass: 'text-red-400', borderClass: 'border-red-500/25' };
  return { bgClass: 'bg-gray-500/15', textClass: 'text-gray-400', borderClass: 'border-white/10' };
}
