'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass } from '@/lib/critic-page-utils';
import HowThisWorks from '@/components/HowThisWorks';
import { ToggleBar, ColumnHeader } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type SortMode = 'reviews' | 'reviews-asc' | 'highest' | 'lowest' | 'alpha';

interface CriticSummary {
  name: string;
  slug: string;
  primaryOutlet: string;
  primaryOutletId: string;
  outlets: string[];
  isFreelancer: boolean;
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  volumeRank: number;
  generosityRank: number;
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'reviews', label: 'MOST REVIEWS' },
  { value: 'highest', label: 'HIGHEST AVG' },
  { value: 'lowest', label: 'LOWEST AVG' },
  { value: 'alpha', label: 'A-Z' },
];

function CriticCard({ critic }: { critic: CriticSummary }) {
  return (
    <Link
      href={`/critics/${critic.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-sm">
          {critic.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
          {critic.name}
          {critic.isFreelancer && (
            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-purple-500/20 text-purple-400 border-purple-500/30 align-middle">
              Freelancer
            </span>
          )}
        </h2>
        <p className="text-gray-500 text-xs sm:text-sm truncate mt-0.5">
          {critic.outlets.join(' · ')}
        </p>
      </div>

      {/* Reviews count */}
      <div className="w-12 sm:w-14 text-center flex-shrink-0">
        <p className="text-lg font-bold text-white">{critic.reviewCount}</p>
      </div>

      {/* Avg Score */}
      <div className="w-10 flex-shrink-0">
        <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(critic.avgScore)} flex items-center justify-center font-bold`}>
          {Math.round(critic.avgScore)}
        </div>
      </div>
    </Link>
  );
}

export default function CriticIndexClient({ critics, totalReviews }: { critics: CriticSummary[]; totalReviews: number }) {
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('reviews');

  const [minReviews, setMinReviews] = useState(5);

  const filtered = useMemo(() => {
    let list = critics.filter(c => c.reviewCount >= minReviews);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.outlets.some(o => o.toLowerCase().includes(q))
      );
    }
    return list;
  }, [search, critics, minReviews]);

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
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Critics' },
      ]} />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Theatre Critics</h1>
        <p className="text-gray-400">
          {critics.length} critics covering Broadway and the West End with {totalReviews.toLocaleString('en-US')} reviews
        </p>
      </div>

      {/* Quick Links */}
      <div className="mb-5">
        <Link
          href="/critics/outlets"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium transition-colors"
        >
          View by Publication
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
          placeholder="Search critics or outlets..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
        />
      </div>

      {/* Sort & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-5 text-sm">
        <ToggleBar
          label="SORT:"
          options={SORT_OPTIONS.map(opt => ({ value: opt.value, label: opt.label }))}
          value={sortMode}
          onChange={setSortMode}
          ariaLabel="Sort critics"
          size="compact"
        />

        <ToggleBar
          label="MIN:"
          options={[
            { value: '1', label: 'ALL' },
            { value: '5', label: '5+' },
            { value: '10', label: '10+' },
            { value: '25', label: '25+' },
          ]}
          value={String(minReviews)}
          onChange={(v) => setMinReviews(Number(v))}
          ariaLabel="Minimum reviews"
          size="compact"
        />
      </div>

      {/* Column Headers */}
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2" role="row" aria-label="Column headers">
        <div className="w-10 flex-shrink-0" />
        <div className="flex-1 min-w-0" />
        <ColumnHeader
          label="Reviews"
          active={sortMode === 'reviews' || sortMode === 'reviews-asc'}
          direction={sortMode === 'reviews' ? 'desc' : sortMode === 'reviews-asc' ? 'asc' : undefined}
          onClick={() => setSortMode(sortMode === 'reviews' ? 'reviews-asc' : 'reviews')}
          className="w-12 sm:w-14 flex-shrink-0"
        />
        <ColumnHeader
          label="Avg"
          active={sortMode === 'highest' || sortMode === 'lowest'}
          direction={sortMode === 'highest' ? 'desc' : sortMode === 'lowest' ? 'asc' : undefined}
          onClick={() => setSortMode(sortMode === 'highest' ? 'lowest' : 'highest')}
          className="w-10 flex-shrink-0"
        />
      </div>

      {/* Critic List */}
      <div className="space-y-2">
        {sorted.map(c => <CriticCard key={c.slug} critic={c} />)}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No critics match &quot;{search}&quot;</p>
        </div>
      )}

      {/* Result count */}
      {sorted.length > 0 && (
        <p className="text-center text-sm text-gray-500 mt-6">
          {sorted.length} critic{sorted.length !== 1 ? 's' : ''}
          {search.trim() ? ` matching "${search}"` : ''}
        </p>
      )}

      {/* How This Works */}
      <HowThisWorks className="mt-8">
        <p>
          Each critic&apos;s average score reflects the mean of their individual review scores across
          all shows they&apos;ve reviewed on Broadway Scorecard. Review scores are derived from explicit
          ratings, sentiment analysis, and language cues in each review.
        </p>
      </HowThisWorks>
    </div>
  );
}
