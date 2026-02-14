'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier } from '@/components/show-cards/ScoreBadge';
import ShowImage from '@/components/ShowImage';

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

function StatusPill({ status }: { status: string }) {
  if (status === 'open') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium">Playing</span>;
  }
  if (status === 'previews') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">Previews</span>;
  }
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400 font-medium">Closed</span>;
}

function TierLabel({ score }: { score: number | null }) {
  const tier = getScoreTier(score);
  if (!tier) return null;
  return <span className="text-xs text-gray-500">{tier.label}</span>;
}

function ShowThumbnail({ src, title }: { src: string | null; title: string }) {
  return (
    <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
      <ShowImage
        sources={[src]}
        alt={title}
        fallback={
          <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs font-bold">
            {title.charAt(0)}
          </div>
        }
        className="w-full h-full object-cover"
        width={40}
        height={40}
      />
    </div>
  );
}

export default function TonyPredictionsTable({ title, description, shows, upcoming }: TonyPredictionsTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showUpcoming, setShowUpcoming] = useState(upcoming.length <= 4);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'title' ? 'asc' : 'desc');
    }
  };

  const sortedShows = useMemo(() => {
    return [...shows].sort((a, b) => {
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
  }, [shows, sortColumn, sortDirection]);

  if (shows.length === 0 && upcoming.length === 0) return null;

  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
      </div>

      {shows.length > 0 && (
        <>
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
                    className="pb-3 pr-4 cursor-pointer group text-right"
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
                {sortedShows.map((show, i) => (
                  <tr key={show.slug} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 pr-2 text-sm text-gray-500 font-medium">{i + 1}</td>
                    <td className="py-3 pr-4">
                      <Link href={`/show/${show.slug}`} className="flex items-center gap-3 group/link">
                        <ShowThumbnail src={show.thumbnailPath} title={show.title} />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white group-hover/link:text-brand transition-colors truncate">
                            {show.title}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{show.venue}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <div className="inline-flex flex-col items-end gap-0.5">
                        <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
                        <TierLabel score={show.compositeScore} />
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-right text-sm text-gray-400">{show.reviewCount}</td>
                    <td className="py-3 pr-4"><StatusPill status={show.status} /></td>
                    <td className="py-3 text-sm text-gray-400">{formatDate(show.openingDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {sortedShows.map((show, i) => (
              <Link
                key={show.slug}
                href={`/show/${show.slug}`}
                className="flex items-center gap-3 p-3 rounded-xl bg-surface-overlay border border-white/5 hover:border-brand/30 transition-colors"
              >
                <span className="text-sm text-gray-500 font-medium w-5 text-center flex-shrink-0">{i + 1}</span>
                <ShowThumbnail src={show.thumbnailPath} title={show.title} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{show.title}</div>
                  <div className="text-xs text-gray-500">{show.venue}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusPill status={show.status} />
                    <span className="text-xs text-gray-500">{show.reviewCount} reviews</span>
                  </div>
                </div>
                <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Upcoming / Coming Soon */}
      {upcoming.length > 0 && (
        <div className="mt-4">
          {upcoming.length > 4 && !showUpcoming ? (
            <button
              onClick={() => setShowUpcoming(true)}
              className="text-sm text-brand hover:text-brand-hover transition-colors font-medium"
            >
              Show {upcoming.length} upcoming shows →
            </button>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Coming Soon ({upcoming.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {upcoming.map(show => (
                  <Link
                    key={show.slug}
                    href={`/show/${show.slug}`}
                    className="flex items-center gap-3 p-3 rounded-lg border border-white/5 hover:border-brand/30 transition-colors"
                  >
                    <ShowThumbnail src={show.thumbnailPath} title={show.title} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{show.title}</div>
                      <div className="text-xs text-gray-500">
                        Opens {formatDate(show.openingDate)} · {show.venue}
                      </div>
                    </div>
                    <div className="w-11 h-11 rounded-lg bg-surface-overlay flex items-center justify-center text-xs text-gray-500 font-bold flex-shrink-0">
                      TBD
                    </div>
                  </Link>
                ))}
              </div>
              {upcoming.length > 4 && showUpcoming && (
                <button
                  onClick={() => setShowUpcoming(false)}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors mt-2"
                >
                  Hide upcoming
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
