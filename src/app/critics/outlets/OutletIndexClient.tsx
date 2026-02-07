'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass, TierBadgeSmall } from '@/lib/critic-page-utils';

type SortMode = 'reviews' | 'reviews-asc' | 'highest' | 'lowest' | 'alpha';
type TierFilter = 'all' | 1 | 2 | 3;

interface OutletSummary {
  name: string;
  slug: string;
  outletId: string;
  tier: 1 | 2 | 3;
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  volumeRank: number;
  generosityRank: number;
  criticCount: number;
  logoDomain: string | null;
  logoColor: string | null;
  logoAbbrev: string | null;
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'reviews', label: 'MOST REVIEWS' },
  { value: 'highest', label: 'HIGHEST AVG' },
  { value: 'lowest', label: 'LOWEST AVG' },
  { value: 'alpha', label: 'A-Z' },
];

const TIER_OPTIONS: { value: TierFilter; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 1, label: 'TIER 1' },
  { value: 2, label: 'TIER 2' },
  { value: 3, label: 'TIER 3' },
];

function OutletCard({ outlet }: { outlet: OutletSummary }) {
  return (
    <Link
      href={`/critics/outlets/${outlet.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Logo */}
      {outlet.logoDomain ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${outlet.logoDomain}&sz=64`}
          alt=""
          aria-hidden="true"
          className="w-8 h-8 rounded flex-shrink-0"
          width={32}
          height={32}
          loading="lazy"
        />
      ) : (
        <div
          className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
          style={{ backgroundColor: outlet.logoColor || '#6b7280' }}
        >
          {outlet.logoAbbrev || outlet.name.charAt(0)}
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
            {outlet.name}
          </h2>
          <TierBadgeSmall tier={outlet.tier} />
        </div>
        <p className="text-gray-400 text-xs sm:text-sm">
          {outlet.criticCount} critic{outlet.criticCount !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Reviews count */}
      <div className="w-14 text-right flex-shrink-0">
        <p className="text-lg font-bold text-white">{outlet.reviewCount}</p>
      </div>

      {/* Avg Score */}
      <div className="w-11 flex-shrink-0">
        <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(outlet.avgScore)} flex items-center justify-center font-bold`}>
          {Math.round(outlet.avgScore)}
        </div>
      </div>
    </Link>
  );
}

export default function OutletIndexClient({ outlets, totalReviews }: { outlets: OutletSummary[]; totalReviews: number }) {
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('reviews');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [minReviews, setMinReviews] = useState(5);

  const filtered = useMemo(() => {
    let list = outlets.filter(o => o.reviewCount >= minReviews);
    if (tierFilter !== 'all') {
      list = list.filter(o => o.tier === tierFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(o => o.name.toLowerCase().includes(q));
    }
    return list;
  }, [search, outlets, tierFilter, minReviews]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'reviews': return list.sort((a, b) => b.reviewCount - a.reviewCount);
      case 'reviews-asc': return list.sort((a, b) => a.reviewCount - b.reviewCount);
      case 'highest': return list.sort((a, b) => b.avgScore - a.avgScore);
      case 'lowest': return list.sort((a, b) => a.avgScore - b.avgScore);
      case 'alpha': return list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [filtered, sortMode]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5"><Link href="/critics" className="hover:text-brand transition-colors">Critics</Link></li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300" aria-current="page">Outlets</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Broadway Review Outlets</h1>
        <p className="text-gray-400">
          {outlets.length} publications with {totalReviews.toLocaleString()} reviews
        </p>
      </div>

      {/* Quick Links */}
      <div className="mb-5">
        <Link
          href="/critics"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium transition-colors"
        >
          View by Critic
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search outlets..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
        />
      </div>

      {/* Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-5 text-sm">
        <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap" role="group" aria-label="Filter by tier">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">TIER:</span>
          {TIER_OPTIONS.map(opt => (
            <button
              key={String(opt.value)}
              onClick={() => setTierFilter(opt.value)}
              className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
                tierFilter === opt.value
                  ? 'text-brand bg-brand/10 sm:bg-transparent'
                  : 'text-gray-300 hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap" role="group" aria-label="Sort outlets">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setSortMode(opt.value)}
              className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
                sortMode === opt.value
                  ? 'text-brand bg-brand/10 sm:bg-transparent'
                  : 'text-gray-300 hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap" role="group" aria-label="Minimum reviews">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">MIN:</span>
          {[1, 5, 10, 25].map(n => (
            <button
              key={n}
              onClick={() => setMinReviews(n)}
              className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
                minReviews === n
                  ? 'text-brand bg-brand/10 sm:bg-transparent'
                  : 'text-gray-300 hover:text-white'
              }`}
            >
              {n === 1 ? 'ALL' : `${n}+`}
            </button>
          ))}
        </div>
      </div>

      {/* Column Headers */}
      <div className="flex items-center gap-3 px-3 sm:px-4 mb-2" role="row" aria-label="Column headers">
        <div className="w-8 flex-shrink-0" />
        <div className="flex-1 min-w-0" />
        <div className="w-14 text-right flex-shrink-0">
          <button
            onClick={() => setSortMode(sortMode === 'reviews' ? 'reviews-asc' : 'reviews')}
            className={`text-[10px] font-medium uppercase tracking-wider transition-colors ${
              sortMode === 'reviews' || sortMode === 'reviews-asc' ? 'text-brand' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Reviews {sortMode === 'reviews' ? '\u25BC' : sortMode === 'reviews-asc' ? '\u25B2' : ''}
          </button>
        </div>
        <div className="w-11 flex-shrink-0">
          <button
            onClick={() => setSortMode(sortMode === 'highest' ? 'lowest' : 'highest')}
            className={`text-[10px] font-medium uppercase tracking-wider transition-colors ${
              sortMode === 'highest' || sortMode === 'lowest' ? 'text-brand' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Avg {sortMode === 'highest' ? '\u25BC' : sortMode === 'lowest' ? '\u25B2' : ''}
          </button>
        </div>
      </div>

      {/* Outlet List */}
      <div className="space-y-2">
        {sorted.map(o => <OutletCard key={o.slug} outlet={o} />)}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">
            {search.trim()
              ? <>No outlets match &quot;{search}&quot;</>
              : 'No outlets in this tier'}
          </p>
        </div>
      )}

      {/* Result count */}
      {sorted.length > 0 && (
        <p className="text-center text-sm text-gray-500 mt-6">
          {sorted.length} outlet{sorted.length !== 1 ? 's' : ''}
          {search.trim() ? ` matching "${search}"` : ''}
          {tierFilter !== 'all' ? ` in Tier ${tierFilter}` : ''}
        </p>
      )}
    </div>
  );
}
