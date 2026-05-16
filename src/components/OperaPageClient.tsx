'use client';

import { useState, useMemo } from 'react';
import { ShowListCard } from '@/components/show-cards';
import type { ShowCardShow, ScoreModeParam } from '@/components/show-cards/types';

export interface OperaPageClientProps {
  shows: ShowCardShow[];
  totalShows: number;
  totalReviews: number;
}

/**
 * Slim opera market page. Lists Met Opera productions in a single column.
 * No advanced filter / search yet — opera coverage is small enough (~10 shows
 * open at peak) that browsing a flat list is reasonable. We can layer search +
 * filter later if the catalog grows.
 *
 * Brand language: "OperaScorecard" — matches Off-Broadway/West End sibling pages.
 * The /opera route is reachable at broadwayscorecard.com/opera and via the
 * dedicated operascorecard.com Vercel domain redirect.
 */
export default function OperaPageClient({ shows, totalShows, totalReviews }: OperaPageClientProps) {
  // Score mode toggle (CRITICS / AUDIENCE) — opera shows rarely have audience
  // ratings so default to critics-only; toggle preserved for future audience
  // ingestion (e.g. Met on Demand reviews).
  const [scoreMode] = useState<ScoreModeParam>('critics');

  const openCount = useMemo(
    () => shows.filter(s => s.status === 'open' || s.status === 'previews').length,
    [shows],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      {/* Hero */}
      <div className="mb-4 sm:mb-8">
        <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
          Opera<span className="text-gradient">Scorecard</span>
          <span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">
            Beta
          </span>
        </h1>
        <h1 className="block sm:hidden text-3xl font-extrabold text-white mb-2 tracking-tight">
          Opera<span className="text-gradient">Scorecard</span>
          <span className="ml-2 align-middle inline-block text-[10px] font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5">
            Beta
          </span>
        </h1>
        <p className="text-gray-400 text-lg sm:text-xl">
          Every Met production. Every critic. One score.
        </p>
        <p className="text-gray-500 text-sm sm:text-base mt-1">
          {totalShows} productions. {totalReviews.toLocaleString()} critic reviews. And counting.
        </p>
        {openCount > 0 && (
          <p className="text-gray-500 text-xs sm:text-sm mt-1">
            {openCount} currently running at the Metropolitan Opera House.
          </p>
        )}
      </div>

      {/* Show list */}
      <div className="space-y-3" role="list" aria-label="Met Opera productions">
        {shows.map((show, index) => (
          <ShowListCard key={show.id} show={show} index={index} scoreMode={scoreMode} />
        ))}
        {shows.length === 0 && (
          <p className="text-gray-500 text-sm py-8 text-center">
            No opera productions in the catalog yet. Check back as Met Opera reviews come in.
          </p>
        )}
      </div>
    </div>
  );
}
