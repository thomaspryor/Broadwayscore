'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { ActorProfile } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, getScoreTextColor, ordinalSuffix } from '@/lib/critic-page-utils';
import { FormatPill, ProductionPill, StatGrid } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type SortCol = 'date' | 'score';
type SortDir = 'asc' | 'desc';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function ShowCard({ show, loading = 'lazy' }: { show: ActorProfile['shows'][0]; loading?: 'eager' | 'lazy' }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
        {show.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.thumbnail, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={56}
            height={56}
            loading={loading}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl">🎭</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {/* Title + format/production pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate">
            {show.title}
          </h3>
          {show.type && <FormatPill type={show.type} />}
          {show.isRevival && <ProductionPill isRevival />}
        </div>
        <p className="text-gray-400 text-xs sm:text-sm">
          {show.openingDate && formatDate(show.openingDate)}
        </p>
        {/* Role + cast type tags */}
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-white/5 text-gray-400 border-white/10">
            {show.role}
          </span>
          {show.castType === 'obc' && !show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-brand/20 text-brand border-brand/30" title="Original Broadway Cast">
              OBC
            </span>
          )}
          {show.castType === 'obc' && show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/30" title="Revival Opening Cast">
              Revival
            </span>
          )}
          {show.castType === 'replacement' && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-cyan-500/20 text-cyan-400 border-cyan-500/30">
              Replacement
            </span>
          )}
          {show.flags && show.flags.some(f => f.toLowerCase().includes('broadway debut')) && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
              Broadway Debut
            </span>
          )}
        </div>
      </div>

      {/* Score */}
      {show.score !== null ? (
        <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(show.score)} flex items-center justify-center font-bold flex-shrink-0`}>
          {Math.round(show.score)}
        </div>
      ) : (
        <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay flex items-center justify-center text-gray-500 font-bold flex-shrink-0">
          —
        </div>
      )}
    </Link>
  );
}

const INITIAL_SHOWS = 50;

export default function ActorDetailClient({
  profile,
  rank,
}: {
  profile: ActorProfile;
  rank: number;
}) {
  const [sortCol, setSortCol] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showCount, setShowCount] = useState(INITIAL_SHOWS);
  const [imgFailed, setImgFailed] = useState(false);

  function handleSort(col: SortCol) {
    if (col === sortCol) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
    setShowCount(INITIAL_SHOWS);
  }

  // Shows currently running — include 'current' cast, or OBC of open shows (fallback when currentCast data hasn't been scraped)
  const openShows = useMemo(() =>
    profile.shows.filter(s => (s.status === 'open' || s.status === 'previews') && (s.castType === 'current' || s.castType === 'obc')),
    [profile.shows]
  );

  const upcomingShows = useMemo(() =>
    profile.shows.filter(s => s.status === 'upcoming'),
    [profile.shows]
  );

  const closedShows = useMemo(() => {
    // Everything not in openShows or upcoming goes to Broadway Credits
    const openIds = new Set(openShows.map(s => s.showId));
    const credits = [...profile.shows.filter(s => s.status !== 'upcoming' && !openIds.has(s.showId))];
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortCol === 'score') {
      return credits.sort((a, b) => dir * ((a.score ?? -999) - (b.score ?? -999)));
    }
    // date sort: by opening date
    return credits.sort((a, b) => {
      const da = a.openingDate ? new Date(a.openingDate).getTime() : 0;
      const db = b.openingDate ? new Date(b.openingDate).getTime() : 0;
      return dir * (da - db);
    });
  }, [profile.shows, openShows, sortCol, sortDir]);

  const visibleClosed = closedShows.slice(0, showCount);
  const remaining = closedShows.length - showCount;

  // Suppress stats for single-show actors (PM feedback: stats look thin)
  const showStats = profile.showCount >= 2;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Cast', href: '/cast' },
        { label: profile.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-4 mb-3">
          {profile.headshot && !imgFailed ? (
            <img
              src={profile.headshot}
              alt={profile.name}
              width={80}
              height={80}
              className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover flex-shrink-0"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-xl sm:text-2xl">
                {profile.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            </div>
          )}
          <h1 className="text-2xl sm:text-3xl font-bold text-white">{profile.name}</h1>
        </div>

        {/* Stats — only show for actors with 2+ shows */}
        {showStats && (
          <StatGrid className="mb-4" stats={[
            { label: 'Shows', value: profile.showCount },
            { label: 'Avg Score', value: profile.avgScore !== null ? Math.round(profile.avgScore) : '—', color: profile.avgScore !== null ? getScoreTextColor(profile.avgScore) : undefined, dimmed: profile.avgScore === null },
            { label: 'Highest', value: profile.highScore ? profile.highScore.score : '—', dimmed: !profile.highScore, subtitle: profile.highScore?.showTitle },
            { label: 'Lowest', value: profile.lowScore ? profile.lowScore.score : '—', dimmed: !profile.lowScore, subtitle: profile.lowScore?.showTitle },
          ]} />
        )}

        {/* Rank + IBDB link */}
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
          {showStats && <span>{ordinalSuffix(rank)} most prolific Broadway actor</span>}
          <a
            href={`https://www.ibdb.com/broadway-cast-staff/${profile.ibdbPersonId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brand transition-colors inline-flex items-center gap-1"
          >
            View on IBDB
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>

      {/* Currently Appearing In */}
      {openShows.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">
            Currently Appearing In
            <span className="text-sm font-normal text-gray-400 ml-2">({openShows.length})</span>
          </h2>
          <div className="space-y-2">
            {openShows.map((show, i) => (
              <ShowCard key={show.showId} show={show} loading={i < 4 ? 'eager' : 'lazy'} />
            ))}
          </div>
        </section>
      )}

      {/* Upcoming */}
      {upcomingShows.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">
            Upcoming
            <span className="text-sm font-normal text-gray-400 ml-2">({upcomingShows.length})</span>
          </h2>
          <div className="space-y-2">
            {upcomingShows.map((show, i) => (
              <ShowCard key={show.showId} show={show} loading="lazy" />
            ))}
          </div>
        </section>
      )}

      {/* Broadway Credits */}
      {closedShows.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-white mb-1">
            Broadway Credits
            <span className="text-sm font-normal text-gray-400 ml-2">({closedShows.length})</span>
          </h2>
          <p className="text-xs text-gray-500 mb-3">Covers productions from 1970 to present. Critic scores available from 2005.</p>

          {/* Column headers — clickable sort */}
          {closedShows.length > 1 && (
            <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2">
              <div className="w-14 flex-shrink-0" />
              <button
                className="flex-1 min-w-0 text-left group/sort"
                onClick={() => handleSort('date')}
                aria-sort={sortCol === 'date' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span className={`text-[10px] font-medium uppercase tracking-wider transition-colors ${
                  sortCol === 'date' ? 'text-brand' : 'text-gray-500 group-hover/sort:text-gray-300'
                }`}>
                  Recent{sortCol === 'date' && <span className="ml-0.5 text-brand">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                </span>
              </button>
              <button
                className="w-11 text-center flex-shrink-0 group/sort"
                onClick={() => handleSort('score')}
                aria-sort={sortCol === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span className={`text-[10px] font-medium uppercase tracking-wider transition-colors ${
                  sortCol === 'score' ? 'text-brand' : 'text-gray-500 group-hover/sort:text-gray-300'
                }`}>
                  Score{sortCol === 'score' && <span className="ml-0.5 text-brand">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                </span>
              </button>
            </div>
          )}

          <div className="space-y-2">
            {visibleClosed.map((show, i) => (
              <ShowCard
                key={show.showId}
                show={show}
                loading={openShows.length === 0 && i < 4 ? 'eager' : 'lazy'}
              />
            ))}
          </div>

          {remaining > 0 && (
            <button
              onClick={() => setShowCount(prev => prev + 50)}
              className="w-full mt-4 py-3 text-sm font-medium text-brand hover:text-brand-hover border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
            >
              Show {Math.min(remaining, 50)} more ({remaining} remaining)
            </button>
          )}
        </section>
      )}

      {profile.showCount === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No shows found for {profile.name}.</p>
        </div>
      )}
    </div>
  );
}
