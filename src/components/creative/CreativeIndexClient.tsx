'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass } from '@/lib/critic-page-utils';
import { ColumnHeader } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type SortColumn = 'name' | 'obc' | 'shows' | 'avg';
type SortDir = 'asc' | 'desc';

const MIN_SHOW_OPTIONS = [0, 3, 5, 10] as const;

interface CreativeProfileSummary {
  name: string;
  slug: string;
  unifiedSlug?: string;
  showCount: number;
  avgScore: number | null;
  openShowCount: number;
  roles: string[];
  obcCount?: number;
  headshot?: string | null;
}

function ProfileCard({ profile, routePath, showObc }: { profile: CreativeProfileSummary; routePath: string; showObc?: boolean }) {
  const href = profile.unifiedSlug ? `/creative/${profile.unifiedSlug}` : `/${routePath}/${profile.slug}`;
  const replacementCount = profile.obcCount !== undefined ? profile.showCount - profile.obcCount : 0;
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = profile.headshot && !imgFailed;
  return (
    <Link
      href={href}
      className="card p-3 sm:p-4 flex items-center gap-3 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Avatar */}
      {showImg ? (
        <img
          src={profile.headshot!}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          className="w-10 h-10 rounded-full object-cover flex-shrink-0"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">
            {profile.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
          </span>
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
          {profile.name}
        </h2>
        <p className="text-gray-400 text-xs sm:text-sm">
          {showObc ? (
            <>
              {profile.showCount} show{profile.showCount !== 1 ? 's' : ''}
              {profile.obcCount !== undefined && profile.obcCount > 0 && (
                <span className="text-brand"> · {profile.obcCount} OBC</span>
              )}
              {replacementCount > 0 && (
                <span className="text-gray-500"> · {replacementCount} other</span>
              )}
            </>
          ) : (
            <>
              {profile.showCount} show{profile.showCount !== 1 ? 's' : ''}
            </>
          )}
          {profile.openShowCount > 0 && (
            <span className="text-emerald-400"> · {profile.openShowCount} running</span>
          )}
        </p>
      </div>

      {/* OBC count — cast pages only */}
      {showObc && (
        <div className="w-10 text-center flex-shrink-0">
          <p className="text-lg font-bold text-brand">{profile.obcCount ?? 0}</p>
        </div>
      )}

      {/* Show count */}
      <div className="w-12 text-center flex-shrink-0">
        <p className="text-lg font-bold text-white">{profile.showCount}</p>
      </div>

      {/* Avg Score */}
      <div className="w-11 flex-shrink-0 ml-1">
        {profile.avgScore !== null ? (
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(profile.avgScore)} flex items-center justify-center font-bold`}>
            {Math.round(profile.avgScore)}
          </div>
        ) : (
          <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay flex items-center justify-center text-gray-500 font-bold">
            —
          </div>
        )}
      </div>
    </Link>
  );
}


export default function CreativeIndexClient({
  profiles,
  categoryLabel,
  routePath,
  totalShows,
  showObcFilter,
  subtitle,
  defaultMinShows = 0,
}: {
  profiles: CreativeProfileSummary[];
  categoryLabel: string;
  routePath: string;
  totalShows: number;
  showObcFilter?: boolean;
  subtitle?: string;
  defaultMinShows?: number;
}) {
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortColumn>('shows');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [visibleCount, setVisibleCount] = useState(100);
  const [obcOnly, setObcOnly] = useState(false);
  const [minShows, setMinShows] = useState(defaultMinShows);

  function handleSort(col: SortColumn) {
    if (col === sortCol) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir(col === 'name' ? 'asc' : 'desc');
    }
    setVisibleCount(100);
  }

  const filtered = useMemo(() => {
    let list = profiles;
    if (minShows > 0) {
      list = list.filter(p => p.showCount >= minShows);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q));
    }
    if (obcOnly) {
      list = list.filter(p => p.obcCount && p.obcCount > 0);
    }
    return list;
  }, [search, profiles, obcOnly, minShows]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortCol) {
      case 'name':
        return list.sort((a, b) => dir * a.name.localeCompare(b.name));
      case 'obc':
        return list.sort((a, b) => dir * ((a.obcCount ?? 0) - (b.obcCount ?? 0)));
      case 'avg':
        return list.sort((a, b) => dir * ((a.avgScore ?? -999) - (b.avgScore ?? -999)));
      default:
        return list.sort((a, b) => dir * (a.showCount - b.showCount));
    }
  }, [filtered, sortCol, sortDir]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: categoryLabel },
      ]} />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Broadway {categoryLabel}</h1>
        <p className="text-gray-400">
          {profiles.length.toLocaleString()} {categoryLabel.toLowerCase()} across {totalShows} Broadway shows
        </p>
        {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={`Search ${categoryLabel.toLowerCase().replace(/s$/, '')}s...`}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setVisibleCount(100); }}
            aria-label={`Search ${categoryLabel.toLowerCase()}`}
            className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
          />
        </div>
      </div>

      {/* Filters — min credits + OBC only */}
      {showObcFilter && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Min credits:</span>
          {MIN_SHOW_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => { setMinShows(n); setVisibleCount(100); }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                minShows === n
                  ? 'text-brand bg-brand/15 border-brand/40'
                  : 'text-gray-400 bg-surface-overlay border-white/10 hover:text-white hover:border-white/20'
              }`}
            >
              {n === 0 ? 'All' : `${n}+`}
            </button>
          ))}
          <span className="text-gray-600 mx-1">|</span>
          <button
            onClick={() => { setObcOnly(!obcOnly); setVisibleCount(100); }}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
              obcOnly
                ? 'text-brand bg-brand/15 border-brand/40'
                : 'text-gray-400 bg-surface-overlay border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            <span title="Original Broadway Cast">OBC</span> Only
          </button>
        </div>
      )}

      {/* Column Headers — clickable for sorting */}
      <div className="flex items-center gap-3 px-3 sm:px-4 mb-2" role="row" aria-label="Column headers">
        <div className="w-10 flex-shrink-0" />
        <ColumnHeader label="Name" active={sortCol === 'name'} direction={sortDir} onClick={() => handleSort('name')} flex align="left" />
        {showObcFilter && (
          <ColumnHeader label="OBC" title="Original Broadway Cast" active={sortCol === 'obc'} direction={sortDir} onClick={() => handleSort('obc')} className="w-10 flex-shrink-0" />
        )}
        <ColumnHeader label={showObcFilter ? 'Total' : 'Shows'} active={sortCol === 'shows'} direction={sortDir} onClick={() => handleSort('shows')} className="w-12 flex-shrink-0" />
        <ColumnHeader label="Avg" active={sortCol === 'avg'} direction={sortDir} onClick={() => handleSort('avg')} className="w-11 flex-shrink-0 ml-1" />
      </div>

      {/* Results */}
      {sorted.length > 0 ? (
        <>
          <div className="space-y-2">
            {sorted.slice(0, visibleCount).map(profile => (
              <ProfileCard key={profile.slug} profile={profile} routePath={routePath} showObc={showObcFilter} />
            ))}
          </div>
          {sorted.length > visibleCount && (
            <button
              onClick={() => setVisibleCount(prev => prev + 100)}
              className="w-full mt-4 py-3 text-sm font-medium text-brand hover:text-brand-hover border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
            >
              Show 100 more ({(sorted.length - visibleCount).toLocaleString()} remaining)
            </button>
          )}
        </>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-gray-400">
            {search.trim()
              ? <>No {categoryLabel.toLowerCase()} found matching &ldquo;{search}&rdquo;</>
              : <>No {categoryLabel.toLowerCase()} found with current filters</>
            }
          </p>
        </div>
      )}

      {/* Result count */}
      {sorted.length > 0 && (search.trim() || obcOnly || minShows > 0) && (
        <p className="text-center text-sm text-gray-500 mt-6">
          {sorted.length.toLocaleString()} {categoryLabel.toLowerCase().replace(/s$/, '')}{sorted.length !== 1 ? 's' : ''}{minShows > 0 ? ` with ${minShows}+ credits` : ''}{search.trim() ? ` matching \u201c${search}\u201d` : ''}{obcOnly ? ' (OBC only)' : ''}
        </p>
      )}
    </div>
  );
}
