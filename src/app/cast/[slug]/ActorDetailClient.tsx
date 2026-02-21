'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { ActorProfile } from '@/lib/data-types';
import type { PersonTonyStats, ShowTonyInfo } from '@/lib/data-tony-noms';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreTextColor, ordinalSuffix } from '@/lib/critic-page-utils';
import { getScoreTier, ScoreBadge, FormatPill, ProductionPill, StatGrid, ColumnHeader } from '@/components/show-cards';
import { TrophyIcon } from '@/components/icons';
import Breadcrumb from '@/components/Breadcrumb';

type SortCol = 'date' | 'score';
type SortDir = 'asc' | 'desc';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function ShowCard({ show, loading = 'lazy', tonyInfo }: { show: ActorProfile['shows'][0]; loading?: 'eager' | 'lazy'; tonyInfo?: ShowTonyInfo }) {
  const tier = show.score !== null ? getScoreTier(show.score) : null;

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
          {(show.castType === 'obc' || show.wasObc) && !show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/30" title="Original Broadway Cast">
              OBC
            </span>
          )}
          {(show.castType === 'obc' || show.wasObc) && show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-white/10 text-gray-400 border-white/15" title="Opening night cast of this revival">
              Opening Cast
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
          {tonyInfo && (
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
                tonyInfo.won
                  ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
                  : 'bg-sky-500/15 text-sky-400 border-sky-500/25'
              }`}
              title={tonyInfo.categories.join(', ')}
            >
              <TrophyIcon className="w-2.5 h-2.5" />
              {tonyInfo.won ? 'Tony Winner' : 'Tony Nom'}
            </span>
          )}
        </div>
      </div>

      {/* Score with tier label */}
      <div className="flex flex-col items-center flex-shrink-0">
        {tier && (
          <span
            className="text-[8px] font-semibold uppercase tracking-wide whitespace-nowrap mb-0.5"
            style={{ color: tier.color }}
            title={tier.tooltip}
          >
            {tier.label}
          </span>
        )}
        <ScoreBadge score={show.score} size="sm" />
      </div>
    </Link>
  );
}

const INITIAL_SHOWS = 50;

export default function ActorDetailClient({
  profile,
  rank,
  highestRatedRank,
  tonyStats,
  tonyByShow,
}: {
  profile: ActorProfile;
  rank: number;
  highestRatedRank: number;
  tonyStats: PersonTonyStats | null;
  tonyByShow: Record<string, ShowTonyInfo>;
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

  // Shows currently running — only actors confirmed in currentCast
  // OBC members of open shows are NOT included (they may have left years ago)
  const openShows = useMemo(() =>
    profile.shows.filter(s => (s.status === 'open' || s.status === 'previews' || s.status === 'upcoming') && s.castType === 'current'),
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
      return credits.sort((a, b) => {
        // Always put unscored shows at the bottom regardless of sort direction
        if (a.score === null && b.score === null) return 0;
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return dir * (a.score - b.score);
      });
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

  // OBC = Original Broadway Cast (non-revival shows only). Revival opening casts don't count.
  const obcCount = useMemo(() =>
    profile.shows.filter(s => (s.castType === 'obc' || s.wasObc) && !s.isRevival).length,
    [profile.shows]
  );
  const musicalCount = useMemo(() =>
    profile.shows.filter(s => s.type === 'Musical').length,
    [profile.shows]
  );
  const playCount = useMemo(() =>
    profile.shows.filter(s => s.type === 'Play').length,
    [profile.shows]
  );

  const highTier = profile.highScore ? getScoreTier(profile.highScore.score) : null;
  const lowTier = profile.lowScore ? getScoreTier(profile.lowScore.score) : null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Cast', href: '/cast' },
        { label: profile.name },
      ]} />

      {/* Header */}
      <div className="mb-3 sm:mb-5">
        <div className="flex items-center gap-4 mb-2">
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
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{profile.name}</h1>
            <a
              href={`https://www.ibdb.com/broadway-cast-staff/${profile.ibdbPersonId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-brand transition-colors inline-flex items-center gap-1 text-xs"
            >
              IBDB
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>

        {/* Stats — only show for actors with 2+ shows */}
        {showStats && (
          <StatGrid className="mb-2" stats={[
            { label: 'Shows', value: profile.showCount, subValue: obcCount > 0 ? `${obcCount} OBC` : undefined, subValueColor: '#eab308' },
            ...(tonyStats ? [{
              label: 'Tonys',
              value: tonyStats.wins > 0 ? `${tonyStats.wins} win${tonyStats.wins !== 1 ? 's' : ''}` : `${tonyStats.nominations} nom${tonyStats.nominations !== 1 ? 's' : ''}`,
              subValue: tonyStats.wins > 0 ? `${tonyStats.nominations} nom${tonyStats.nominations !== 1 ? 's' : ''}` : undefined,
              subValueColor: '#fbbf24',
            }] : []),
            { label: 'Avg Score', value: profile.avgScore !== null ? Math.round(profile.avgScore) : '—', color: profile.avgScore !== null ? getScoreTextColor(profile.avgScore) : undefined, dimmed: profile.avgScore === null, subValue: highestRatedRank > 0 && highestRatedRank <= 200 ? `${ordinalSuffix(highestRatedRank)} highest-rated` : undefined },
            { label: 'Highest', value: profile.highScore ? profile.highScore.score : '—', color: highTier?.color, dimmed: !profile.highScore, subtitle: profile.highScore?.showTitle },
            { label: 'Lowest', value: profile.lowScore ? profile.lowScore.score : '—', color: lowTier?.color, dimmed: !profile.lowScore, subtitle: profile.lowScore?.showTitle },
          ]} />
        )}

        {/* Genre split + prolific rank */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-gray-400">
          {showStats && (musicalCount > 0 || playCount > 0) && (
            <span>{[musicalCount > 0 && `${musicalCount} musical${musicalCount !== 1 ? 's' : ''}`, playCount > 0 && `${playCount} play${playCount !== 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</span>
          )}
          {showStats && rank <= 200 && (
            <><span className="text-gray-600">·</span><span>{ordinalSuffix(rank)} most prolific</span></>
          )}
        </div>
      </div>

      {/* Currently Appearing In */}
      {openShows.length > 0 && (
        <section className="mb-3 sm:mb-6">
          <h2 className="text-lg font-bold text-white mb-2">
            Currently Appearing In
            <span className="text-sm font-normal text-gray-400 ml-2">({openShows.length})</span>
          </h2>
          <div className="space-y-2">
            {openShows.map((show, i) => (
              <ShowCard key={show.showId} show={show} loading={i < 4 ? 'eager' : 'lazy'} tonyInfo={tonyByShow[show.showId]} />
            ))}
          </div>
        </section>
      )}

      {/* Upcoming */}
      {upcomingShows.length > 0 && (
        <section className="mb-3 sm:mb-6">
          <h2 className="text-lg font-bold text-white mb-2">
            Upcoming
            <span className="text-sm font-normal text-gray-400 ml-2">({upcomingShows.length})</span>
          </h2>
          <div className="space-y-2">
            {upcomingShows.map((show, i) => (
              <ShowCard key={show.showId} show={show} loading="lazy" tonyInfo={tonyByShow[show.showId]} />
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
          <p className="text-xs text-gray-500 mb-1">Covers productions from 1970. Critic scores available from 2005.</p>

          {/* Column headers — clickable sort */}
          {closedShows.length > 1 && (
            <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2">
              <div className="w-14 flex-shrink-0" />
              <ColumnHeader label="Recent" active={sortCol === 'date'} direction={sortDir} onClick={() => handleSort('date')} flex align="left" />
              <ColumnHeader label="Score" active={sortCol === 'score'} direction={sortDir} onClick={() => handleSort('score')} className="w-14 flex-shrink-0" />
            </div>
          )}

          <div className="space-y-2">
            {visibleClosed.map((show, i) => (
              <ShowCard
                key={show.showId}
                show={show}
                loading={openShows.length === 0 && i < 4 ? 'eager' : 'lazy'}
                tonyInfo={tonyByShow[show.showId]}
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
