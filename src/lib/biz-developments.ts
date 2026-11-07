/**
 * Recent Developments on /biz (a short list) and /biz/developments (every
 * item). One builder so both pages say the same thing about a show.
 *
 * Order: shows at risk now, then announced closings (soonest first), then
 * past recoupments and closings (newest first). Announced closings used to
 * trail the past events, so a November closing sat under May recoupments.
 */

import type { DevelopmentItem } from '@/components/biz/RecentDevelopmentsList';
import { getRecentRecoupments, getRecentClosings, getUpcomingClosings, getShowsAtRisk } from '@/lib/data-commercial';
import { formatDevelopmentDate, sortNewestFirst } from '@/lib/biz-format';
import { lossOutcomePhrase } from '@/lib/commercial-display';

/** Windows and caps for each list; `full` is the dedicated page. */
const LIMITS = {
  short: { recoupMonths: 12, recoups: 4, closingMonths: 3, closings: 3, upcoming: 2, atRisk: 2 },
  full: { recoupMonths: 24, recoups: Infinity, closingMonths: 24, closings: Infinity, upcoming: Infinity, atRisk: Infinity },
} as const;

export function buildDevelopments(scope: keyof typeof LIMITS = 'short'): DevelopmentItem[] {
  const lim = LIMITS[scope];
  const past: Array<{ isoDate: string; item: DevelopmentItem }> = [];

  for (const show of getRecentRecoupments(lim.recoupMonths).slice(0, lim.recoups)) {
    past.push({
      isoDate: show.recoupDate,
      item: {
        date: formatDevelopmentDate(show.recoupDate),
        type: 'recouped',
        showTitle: show.title,
        showSlug: show.slug,
        // No week count for a year-only recoupment date or one reported after closing (calculateWeeksToRecoup → null).
        description: show.weeksToRecoup === null || show.weeksIsEstimate
          ? (show.reportedAfterClosing ? 'recouped, reported after closing' : 'recouped')
          : `recouped about ${show.weeksToRecoup} weeks after ${show.fromCommercialRun ? 'its commercial run began' : 'opening'}`,
      },
    });
  }

  for (const show of getRecentClosings(lim.closingMonths).slice(0, lim.closings)) {
    past.push({
      isoDate: show.closingDate,
      item: {
        date: formatDevelopmentDate(show.closingDate),
        type: 'closing',
        showTitle: show.title,
        showSlug: show.slug,
        description: lossOutcomePhrase({ designation: show.designation, designationBasis: show.designationBasis ?? undefined }, 'closing'),
      },
    });
  }

  const atRisk: DevelopmentItem[] = getShowsAtRisk().slice(0, lim.atRisk).map((show) => ({
    date: 'Now',
    type: 'at-risk',
    showTitle: show.title,
    showSlug: show.slug,
    description: '4-week average gross below estimated break-even',
  }));

  const upcoming: DevelopmentItem[] = [...getUpcomingClosings()]
    .sort((a, b) => a.closingDate.localeCompare(b.closingDate))
    .slice(0, lim.upcoming)
    .map((show) => ({
      date: formatDevelopmentDate(show.closingDate),
      type: 'closing-announced',
      showTitle: show.title,
      showSlug: show.slug,
      description: 'closing announced',
    }));

  return [...atRisk, ...upcoming, ...sortNewestFirst(past, (p) => p.isoDate).map((p) => p.item)];
}
