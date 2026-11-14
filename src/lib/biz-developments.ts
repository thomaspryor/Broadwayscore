/**
 * Recent Developments on /biz (a short list) and /biz/developments (every
 * item). One builder so both pages say the same thing about a show.
 *
 * Order: Closing Watch (our estimate, BRO-7246), shows at risk now, then announced closings (soonest first), then
 * past recoupments and closings (newest first). Announced closings used to
 * trail the past events, so a November closing sat under May recoupments.
 */

import { splitStruggling } from '@/lib/closing-watch';
import type { DevelopmentItem } from '@/components/biz/RecentDevelopmentsList';
import { getRecentRecoupments, getRecentClosings, getUpcomingClosings, getShowsAtRisk, getClosingWatch } from '@/lib/data-commercial';
import { formatDevelopmentDate, formatMonthYear, sortNewestFirst } from '@/lib/biz-format';
import { lossOutcomePhrase } from '@/lib/commercial-display';

/** Windows and caps for each list; `full` is the dedicated page. */
const LIMITS = {
  short: { recoupMonths: 12, recoups: 4, closingMonths: 3, closings: 3, upcoming: 2, atRisk: 2, watch: 2 },
  full: { recoupMonths: 24, recoups: Infinity, closingMonths: 24, closings: Infinity, upcoming: Infinity, atRisk: Infinity, watch: Infinity },
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

  const watchShows = getClosingWatch();
  const watchSlugs = new Set(watchShows.map((s) => s.slug));
  // A show that already announced its closing while below break-even is no
  // longer "at risk": it is closing before recouping (owner 2026-11-10).
  const split = splitStruggling(getShowsAtRisk().filter((s) => !watchSlugs.has(s.slug)));
  const closingUnrecoupedSlugs = new Set(split.closing.map((s) => s.slug));
  const atRisk: DevelopmentItem[] = split.atRisk.slice(0, lim.atRisk).map((show) => ({
    date: 'Now',
    type: 'at-risk',
    showTitle: show.title,
    showSlug: show.slug,
    description: '4-week average gross below estimated break-even',
  }));

  const watch: DevelopmentItem[] = watchShows.slice(0, lim.watch).map((show) => {
    const month = formatMonthYear(show.likelyClosing?.median);
    return {
      date: 'Now',
      type: 'closing-watch',
      showTitle: show.title,
      showSlug: show.slug,
      description: month
        ? `no closing announced, grosses under break-even; our estimate: likely closes around ${month}`
        : 'no closing announced, grosses under break-even',
    };
  });

  // Closings in date order: plain announced closings plus the "closing before
  // recouping" shows, whose announced date may be further out than two months.
  // Each group keeps its own limit (the closing-before-recouping one takes At Risk's), then they merge by date.
  const upcoming: DevelopmentItem[] = [
    ...getUpcomingClosings()
      .filter((show) => !closingUnrecoupedSlugs.has(show.slug))
      .sort((a, b) => a.closingDate.localeCompare(b.closingDate))
      .slice(0, lim.upcoming)
      .map((show) => ({ closingDate: show.closingDate, title: show.title, slug: show.slug, description: 'closing announced' })),
    ...[...split.closing].sort((a, b) => (a.closingDate as string).localeCompare(b.closingDate as string)).slice(0, lim.atRisk).map((show) => ({
      closingDate: show.closingDate as string,
      title: show.title,
      slug: show.slug,
      description: 'closing before recouping, grosses below estimated break-even',
    })),
  ]
    .sort((a, b) => a.closingDate.localeCompare(b.closingDate))
    .map((show) => ({
      date: formatDevelopmentDate(show.closingDate),
      type: 'closing-announced',
      showTitle: show.title,
      showSlug: show.slug,
      description: show.description,
    }));

  return [...watch, ...atRisk, ...upcoming, ...sortNewestFirst(past, (p) => p.isoDate).map((p) => p.item)];
}
