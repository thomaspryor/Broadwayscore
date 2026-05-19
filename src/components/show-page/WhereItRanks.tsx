'use client';

/**
 * WhereItRanks — bottom-of-show-page rank card.
 *
 * 5 metrics × 3 columns (open market / this season / all-time*).
 * Format toggle: "All shows" + the show's own format (Musical OR Play, never both).
 * Cells link to the matching browse page where one exists; otherwise plain text.
 *
 * Renders nothing if both rank sets are null (feature-gated off, or no rankable
 * data for this show in any pool).
 *
 * Mounted by src/app/show/[slug]/page.tsx behind featureFlags.showRanks.
 */

import { useState } from 'react';
import Link from 'next/link';
import type { ComputedShow } from '@/lib/data-types';
import type { ShowRanks, RankCell, RankMetric } from '@/lib/data-show-ranks';
import {
  getBrowseSlug,
  getBestRightNowSlug,
  getAllTimeSlug,
  getSeasonSlug,
  getMarketLabel,
} from '@/lib/browse-slugs';

interface Props {
  /** Ranks computed with format: 'all' — all open shows in the market. */
  ranks: ShowRanks | null;
  /** Ranks computed with format: show.type — narrowed to musical-or-play pool.
   *  Null if the show isn't a musical or play (Special / Limited Engagement). */
  ranksByFormat: ShowRanks | null;
  show: ComputedShow;
}

type FormatChoice = 'all' | 'own';

interface RowDef {
  metric: RankMetric;
  label: string;
  /** Tooltip text shown on "—" cells in pools where this metric is N/A. */
  notApplicableHint?: string;
}

const ROWS: RowDef[] = [
  { metric: 'critic', label: 'CriticScore' },
  { metric: 'audience', label: 'AudienceGrade' },
  { metric: 'awards', label: 'Awards Score', notApplicableHint: "Award data isn't tracked for this market" },
  { metric: 'boxOffice', label: 'Box Office', notApplicableHint: "Box-office data isn't tracked for this market" },
  { metric: 'overall', label: 'Overall' },
];

export default function WhereItRanks({ ranks, ranksByFormat, show }: Props) {
  // Default to the show's own format if one is available. Falls back to 'all'
  // for Specials / Limited Engagements where ranksByFormat is null.
  const ownFormatAvailable = ranksByFormat !== null && (show.type === 'musical' || show.type === 'play');
  const [choice, setChoice] = useState<FormatChoice>(ownFormatAvailable ? 'own' : 'all');

  if (!ranks && !ranksByFormat) return null;

  const activeRanks = choice === 'own' && ranksByFormat ? ranksByFormat : ranks;
  if (!activeRanks) return null;

  const market = show.category;
  const marketName = getMarketLabel(market);
  const formatNoun = choice === 'own' && show.type === 'musical' ? 'musicals'
    : choice === 'own' && show.type === 'play' ? 'plays'
    : 'shows';

  // Cell-link computation. Returns the href or null (renders unlinked).
  function linkFor(metric: RankMetric, pool: 'openMarket' | 'season' | 'allTime'): string | null {
    if (pool === 'openMarket') {
      switch (metric) {
        case 'critic':
          return `/browse/${getBrowseSlug(market, show.type)}`;
        case 'audience':
          return '/audience-buzz';
        case 'awards':
          if (market === 'broadway') return '/tony-awards/predictions';
          if (market === 'west-end') return '/olivier-awards';
          // Off-Broadway and off-west-end shows have no dedicated awards
          // page (they're not Tony/Olivier-eligible). Explicit handling
          // required by the west-end/off-west-end co-occurrence lint —
          // see tests/unit/regression-guards.test.mjs.
          return null;
        case 'boxOffice':
          return '/box-office';
        case 'overall':
          return `/browse/${getBestRightNowSlug(market)}`;
      }
    }
    if (pool === 'season') {
      if (metric === 'critic' || metric === 'overall') {
        const slug = getSeasonSlug(market, null);
        return slug ? `/browse/${slug}` : null;
      }
      if (metric === 'awards' && market === 'broadway') {
        return '/tony-awards/predictions';
      }
      return null; // audience/boxOffice season cells: deep-link not wired in v1
    }
    if (pool === 'allTime') {
      if (metric === 'critic' || metric === 'overall') {
        const slug = getAllTimeSlug(market);
        return slug ? `/browse/${slug}` : null;
      }
      return null;
    }
    return null;
  }

  return (
    <section
      data-testid="where-it-ranks"
      className="card p-4 sm:p-5 mb-8 space-y-3"
      aria-labelledby="where-it-ranks-heading"
    >
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 id="where-it-ranks-heading" className="text-xs font-semibold uppercase tracking-[0.08em] text-gray-500">
            Where it ranks
          </h2>
          <p className="text-[11px] text-gray-500 mt-1">
            Compared against all open {marketName} {formatNoun}
          </p>
        </div>
        {ownFormatAvailable && (
          <div
            className="inline-flex bg-surface-overlay border border-white/5 rounded-lg p-0.5 gap-0.5 self-start sm:self-auto"
            role="tablist"
            aria-label="Filter by format"
          >
            <button
              type="button"
              role="tab"
              aria-selected={choice === 'all'}
              onClick={() => setChoice('all')}
              className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-colors ${
                choice === 'all' ? 'bg-white/10 text-gray-50' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              All shows
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={choice === 'own'}
              onClick={() => setChoice('own')}
              className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-colors capitalize ${
                choice === 'own' ? 'bg-white/10 text-gray-50' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {show.type === 'musical' ? 'Musicals' : 'Plays'}
            </button>
          </div>
        )}
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 pb-2">
              Metric
            </th>
            <th className="text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 pb-2">
              Open {marketName}
            </th>
            <th className="text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 pb-2 hidden sm:table-cell">
              This season
            </th>
            <th className="text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 pb-2 hidden sm:table-cell">
              All-time<span className="text-gray-600 font-normal">*</span>
            </th>
            {/* Mobile: collapse Season + All-time into a single trailing column to fit 390px. */}
            <th className="text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 pb-2 sm:hidden">
              Seas. · All<span className="text-gray-600 font-normal">*</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.filter(row => {
            if (row.metric === 'boxOffice' && (market === 'off-broadway' || market === 'off-west-end')) return false;
            return true;
          }).map((row, idx, visibleRows) => {
            const isLast = idx === visibleRows.length - 1;
            const rs = activeRanks[row.metric];
            // Denominators vary widely per-metric in the all-time column
            // (CriticScore=267, AudienceGrade=251, Awards=234, Box Office=252)
            // and a "Box Office #18" without context reads as the same pool
            // as "CriticScore #42" when they're not. Always show "of N" on
            // all-time cells. Other columns are tighter — keep them clean,
            // only Overall surfaces the denominator there.
            const showOverallDenom = isLast;
            return (
              <tr key={row.metric} className={isLast ? 'border-t border-white/10' : ''}>
                <td className={`py-2 pr-2 text-gray-300 align-top ${isLast ? 'pt-3 font-semibold text-gray-100' : ''}`}>
                  {row.label}
                </td>

                <td className={`py-2 pl-2 text-right align-top ${isLast ? 'pt-3' : ''}`}>
                  <Cell cell={rs.openMarket} href={linkFor(row.metric, 'openMarket')} naHint={row.notApplicableHint} emphasis showDenominator={showOverallDenom} />
                </td>

                <td className={`hidden sm:table-cell py-2 pl-2 text-right align-top ${isLast ? 'pt-3' : ''}`}>
                  <Cell cell={rs.season} href={linkFor(row.metric, 'season')} naHint={row.notApplicableHint} emphasis showDenominator={showOverallDenom} />
                </td>

                {/* All-time column: ALWAYS show "of N" so per-metric pool
                    differences are explicit. */}
                <td className={`hidden sm:table-cell py-2 pl-2 text-right align-top ${isLast ? 'pt-3' : ''}`}>
                  <Cell cell={rs.allTime} href={linkFor(row.metric, 'allTime')} naHint={row.notApplicableHint} showDenominator />
                </td>

                {/* Mobile combined column — show season if present, fall back
                    to all-time. Always render denominator (so the fallback to
                    all-time is unambiguous). */}
                <td className={`sm:hidden py-2 pl-2 text-right align-top ${isLast ? 'pt-3' : ''}`}>
                  {rs.season ? (
                    <Cell cell={rs.season} href={linkFor(row.metric, 'season')} naHint={row.notApplicableHint} emphasis showDenominator={showOverallDenom} />
                  ) : (
                    <Cell cell={rs.allTime} href={linkFor(row.metric, 'allTime')} naHint={row.notApplicableHint} showDenominator />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-[10px] text-gray-500">
        <span className="text-gray-600">*</span> All-time pool: shows scored 2005–present. Ranks update daily.
      </p>
    </section>
  );
}

function Cell({
  cell,
  href,
  naHint,
  emphasis,
  showDenominator,
}: {
  cell: RankCell | null;
  href: string | null;
  naHint?: string;
  emphasis?: boolean;
  /** When true, renders the denominator inline ("/M") in a lighter weight
   *  next to the rank. Same line, no wrap. */
  showDenominator?: boolean;
}) {
  if (!cell) {
    return (
      <span
        className="text-gray-600 tabular-nums cursor-help"
        title={naHint ?? 'Not enough data for this pool'}
      >
        —
      </span>
    );
  }
  const rankClass = emphasis
    ? 'font-bold text-gray-100 tabular-nums'
    : 'text-gray-500 tabular-nums';
  const rankNode = <span className={rankClass}>#{cell.rank}</span>;
  // Inline "/M" — lighter weight than the rank, same line, no wrap.
  const denomNode = showDenominator ? (
    <span className="font-normal text-gray-500 tabular-nums">/{cell.total}</span>
  ) : null;
  const content = (
    <span className="whitespace-nowrap tabular-nums">
      {rankNode}
      {denomNode}
    </span>
  );
  if (!href) {
    // Visually distinct from links: no underline, default cursor, no hover.
    return content;
  }
  return (
    <Link
      href={href}
      className="whitespace-nowrap tabular-nums hover:text-white hover:underline underline-offset-[3px] decoration-white/20"
    >
      {rankNode}
      {denomNode}
    </Link>
  );
}
