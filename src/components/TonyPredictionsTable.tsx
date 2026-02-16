'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier, StatusBadge } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';

export interface SerializedTonyShow {
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  status: string;
  compositeScore: number | null;
  reviewCount: number;
  thumbnailPath: string | null;
}

interface TonyPredictionsTableProps {
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
}

type SortColumn = 'score' | 'title' | 'openingDate' | 'reviews';
type SortDirection = 'asc' | 'desc';

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection | null }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">↕</span>
    );
  }
  return <span className="ml-1 text-brand">{direction === 'asc' ? '↑' : '↓'}</span>;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function TierLabel({ score, reviewCount, status }: { score: number | null; reviewCount: number; status: string }) {
  if (status === 'previews' || reviewCount < 5) return null;
  const tier = getScoreTier(score);
  if (!tier) return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
      style={{ color: tier.color }}
    >
      {tier.label}
    </span>
  );
}

function ShowThumbnail({ src, title, status }: { src: string | null; title: string; status: string }) {
  const optimizedSrc = src ? getOptimizedImageUrl(src, 'thumbnail') : null;
  return (
    <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
      <ShowImage
        sources={[optimizedSrc]}
        alt={`${title} Broadway show`}
        fallback={
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 px-2" aria-hidden="true">
            <div className="text-lg mb-0.5">🎭</div>
            {status === 'previews' && (
              <div className="text-[8px] text-gray-500 text-center font-medium leading-tight">Images<br />soon</div>
            )}
          </div>
        }
        className="w-full h-full object-cover"
        width={64}
        height={64}
      />
    </div>
  );
}

export default function TonyPredictionsTable({ title, description, shows, upcoming }: TonyPredictionsTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'title' ? 'asc' : 'desc');
    }
  };

  // Combine scored and upcoming into one unified list
  const allShows = useMemo(() => {
    const scored = [...shows].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      switch (sortColumn) {
        case 'score':
          aVal = a.compositeScore;
          bVal = b.compositeScore;
          break;
        case 'title':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'openingDate':
          aVal = a.openingDate;
          bVal = b.openingDate;
          break;
        case 'reviews':
          aVal = a.reviewCount;
          bVal = b.reviewCount;
          break;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      const cmp = typeof aVal === 'string'
        ? aVal.localeCompare(bVal as string)
        : (aVal as number) - (bVal as number);

      return sortDirection === 'asc' ? cmp : -cmp;
    });

    // Upcoming shows after scored, sorted by opening date
    const upcomingSorted = [...upcoming].sort((a, b) =>
      (a.openingDate || '').localeCompare(b.openingDate || '')
    );

    return [...scored, ...upcomingSorted];
  }, [shows, upcoming, sortColumn, sortDirection]);

  if (allShows.length === 0) return null;

  const isUpcoming = (show: SerializedTonyShow) =>
    show.status === 'previews' || show.reviewCount < 5;

  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/5">
              <th className="pb-3 pr-2 w-8">#</th>
              <th
                className="pb-3 pr-4 cursor-pointer group"
                onClick={() => handleSort('title')}
              >
                Show
                <SortIcon active={sortColumn === 'title'} direction={sortColumn === 'title' ? sortDirection : null} />
              </th>
              <th
                className="pb-3 pr-4 cursor-pointer group text-center"
                onClick={() => handleSort('score')}
              >
                Score
                <SortIcon active={sortColumn === 'score'} direction={sortColumn === 'score' ? sortDirection : null} />
              </th>
              <th
                className="pb-3 pr-4 cursor-pointer group text-right"
                onClick={() => handleSort('reviews')}
              >
                Reviews
                <SortIcon active={sortColumn === 'reviews'} direction={sortColumn === 'reviews' ? sortDirection : null} />
              </th>
              <th className="pb-3 pr-4">Status</th>
              <th
                className="pb-3 cursor-pointer group"
                onClick={() => handleSort('openingDate')}
              >
                Opened
                <SortIcon active={sortColumn === 'openingDate'} direction={sortColumn === 'openingDate' ? sortDirection : null} />
              </th>
            </tr>
          </thead>
          <tbody>
            {allShows.map((show, i) => {
              const upcoming = isUpcoming(show);
              // Scored shows (first N items) get numbered ranks; upcoming get no rank
              const rank = !upcoming ? i + 1 : null;
              return (
                <tr key={show.slug} className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors ${upcoming ? 'opacity-60' : ''}`}>
                  <td className="py-3 pr-2 text-sm text-gray-500 font-medium">
                    {rank ?? ''}
                  </td>
                  <td className="py-3 pr-4">
                    <Link href={`/show/${show.slug}`} className="flex items-center gap-3 group/link">
                      <ShowThumbnail src={show.thumbnailPath} title={show.title} status={show.status} />
                      <div className="min-w-0">
                        <div className={`text-sm font-semibold group-hover/link:text-brand transition-colors truncate ${upcoming ? 'text-gray-400' : 'text-white'}`}>
                          {show.title}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {upcoming ? `Opens ${formatDate(show.openingDate)} · ${show.venue}` : show.venue}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-col items-center gap-0.5">
                      <TierLabel score={show.compositeScore} reviewCount={show.reviewCount} status={show.status} />
                      <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-right text-sm text-gray-400">
                    {upcoming ? '—' : show.reviewCount}
                  </td>
                  <td className="py-3 pr-4"><StatusBadge status={show.status} /></td>
                  <td className="py-3 text-sm text-gray-400">
                    {upcoming ? `Opens ${formatDate(show.openingDate)}` : formatDate(show.openingDate)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-2">
        {allShows.map((show, i) => {
          const upcoming = isUpcoming(show);
          const rank = !upcoming ? i + 1 : null;
          return (
            <Link
              key={show.slug}
              href={`/show/${show.slug}`}
              className={`flex items-center gap-3 p-3 rounded-xl bg-surface-overlay border border-white/5 hover:border-brand/30 transition-colors ${upcoming ? 'opacity-60' : ''}`}
            >
              <span className="text-sm text-gray-500 font-medium w-5 text-center flex-shrink-0">
                {rank ?? ''}
              </span>
              <ShowThumbnail src={show.thumbnailPath} title={show.title} status={show.status} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold truncate ${upcoming ? 'text-gray-400' : 'text-white'}`}>
                  {show.title}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {upcoming ? `Opens ${formatDate(show.openingDate)}` : show.venue}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={show.status} />
                  {!upcoming && (
                    <span className="text-xs text-gray-500">{show.reviewCount} reviews</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                <TierLabel score={show.compositeScore} reviewCount={show.reviewCount} status={show.status} />
                <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
