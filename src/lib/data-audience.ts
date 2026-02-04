// Audience Buzz data module
// Imports: audience-buzz.json (~210 KB) + shows.json (~1.3 MB for slug→id lookup)

import type { AudienceBuzzDesignation, AudienceBuzzData } from './data-types';
import audienceBuzzData from '../../data/audience-buzz.json';
import showsData from '../../data/shows.json';

interface AudienceBuzzFile {
  _meta: {
    lastUpdated: string;
    sources: string[];
    designationThresholds: Record<string, string>;
    notes: string;
  };
  shows: Record<string, AudienceBuzzData>;
}

const audienceBuzz = audienceBuzzData as unknown as AudienceBuzzFile;
const rawShows = showsData.shows as Array<{ id: string; slug: string }>;

/**
 * Get audience buzz data for a specific show by ID
 */
export function getAudienceBuzz(showId: string): AudienceBuzzData | undefined {
  return audienceBuzz.shows[showId];
}

/**
 * Get audience buzz by slug (looks up show ID first)
 */
export function getAudienceBuzzBySlug(slug: string): AudienceBuzzData | undefined {
  const show = rawShows.find(s => s.slug === slug);
  if (!show) return undefined;
  return audienceBuzz.shows[show.id];
}

/**
 * Get all shows sorted by audience buzz score
 */
export function getShowsByAudienceBuzz(limit = 10): Array<{ showId: string; data: AudienceBuzzData }> {
  const results: Array<{ showId: string; data: AudienceBuzzData }> = [];

  for (const [showId, data] of Object.entries(audienceBuzz.shows)) {
    results.push({ showId, data });
  }

  return results
    .sort((a, b) => b.data.combinedScore - a.data.combinedScore)
    .slice(0, limit);
}

/**
 * Compute audience letter grade from combinedScore.
 * Grade scale shifted down 2 points from standard academic.
 * Colors use solid fills matching the critic score badge style.
 */
export function getAudienceGrade(score: number): {
  grade: string;
  label: string;
  color: string;
  textColor: string;
  tooltip: string;
} {
  if (score >= 93) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#ffffff', tooltip: 'Audiences love it' };
  if (score >= 88) return { grade: 'A', label: 'Loving It', color: '#16a34a', textColor: '#ffffff', tooltip: 'Audiences love it' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#ffffff', tooltip: 'Strong audience reception' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#ffffff', tooltip: 'Solid audience reception' };
  if (score >= 73) return { grade: 'B', label: 'Shrugging', color: '#f59e0b', textColor: '#1a1a1a', tooltip: 'Mixed-positive reception' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#1a1a1a', tooltip: 'Mixed audience reception' };
  if (score >= 63) return { grade: 'C+', label: 'Loathing It', color: '#ef4444', textColor: '#ffffff', tooltip: 'Below-average reception' };
  if (score >= 58) return { grade: 'C', label: 'Loathing It', color: '#dc2626', textColor: '#ffffff', tooltip: 'Weak audience reception' };
  if (score >= 53) return { grade: 'C-', label: 'Loathing It', color: '#b91c1c', textColor: '#ffffff', tooltip: 'Poor audience reception' };
  if (score >= 48) return { grade: 'D', label: 'Loathing It', color: '#991b1b', textColor: '#ffffff', tooltip: 'Very poor reception' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#ffffff', tooltip: 'Audiences dislike it' };
}

/**
 * Get Tailwind classes for an audience grade badge (used in AudienceBuzzCard).
 */
export function getAudienceGradeClasses(score: number): {
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
  return { bgClass: 'bg-gray-500/15', textClass: 'text-gray-400', borderClass: 'border-gray-500/25' };
}

/**
 * Get audience buzz designation color class
 * @deprecated Use getAudienceGradeClasses instead
 */
export function getAudienceBuzzColor(designation: AudienceBuzzDesignation): {
  bgClass: string;
  textClass: string;
  borderClass: string;
} {
  switch (designation) {
    case 'Loving':
      return {
        bgClass: 'bg-gradient-to-r from-rose-500/20 to-pink-500/20',
        textClass: 'text-rose-400',
        borderClass: 'border-rose-500/30',
      };
    case 'Liking':
      return {
        bgClass: 'bg-emerald-500/15',
        textClass: 'text-emerald-400',
        borderClass: 'border-emerald-500/25',
      };
    case 'Shrugging':
      return {
        bgClass: 'bg-amber-500/15',
        textClass: 'text-amber-400',
        borderClass: 'border-amber-500/25',
      };
    case 'Loathing':
      return {
        bgClass: 'bg-gray-500/15',
        textClass: 'text-gray-400',
        borderClass: 'border-gray-500/25',
      };
  }
}

/**
 * Get audience buzz data last updated timestamp
 */
export function getAudienceBuzzLastUpdated(): string {
  return audienceBuzz._meta.lastUpdated;
}
