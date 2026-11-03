'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import type { CriticProfile, ProfileReview } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, getScoreTextColor, formatDate, ordinalSuffix } from '@/lib/critic-page-utils';
import { ToggleBar, StatGrid } from '@/components/show-cards';
import AvatarImage from '@/components/AvatarImage';
import Breadcrumb from '@/components/Breadcrumb';
import { getReviewKey } from '../../../../scripts/lib/review-list-key';
import { nestQuotes } from '@/lib/nest-quotes';
import { getInitials } from '@/lib/name-initials';
import { getCriticBio } from '@/config/critic-bios';
import type { PublicCriticProfile } from '@/lib/critic-server-types';
import CriticClaimPanel from '@/components/critics/CriticClaimPanel';

type SortMode = 'recent' | 'highest' | 'lowest';
type MarketFilter = 'all' | 'broadway' | 'west-end' | 'off-west-end' | 'off-broadway';

const MARKET_LABELS: Record<Exclude<MarketFilter, 'all'>, string> = {
  'broadway': 'Broadway',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
  'off-broadway': 'Off-Broadway',
};

const MARKET_FILTER_MIN = 3;

/** Extract opening year from showOpeningDate string (e.g., "2021-12-09" → "2021") */
function getShowYear(review: ProfileReview): string | null {
  if (review.showOpeningDate) {
    const year = review.showOpeningDate.slice(0, 4);
    if (/^\d{4}$/.test(year)) return year;
  }
  return null;
}

function ReviewCard({ review, showYear, loading = 'lazy' }: { review: ProfileReview; showYear?: string | null; loading?: 'eager' | 'lazy' }) {
  return (
    <article className="card p-4 flex gap-4">
      {/* Thumbnail */}
      <Link href={`/show/${review.showSlug}`} className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0 self-start">
        {review.showThumbnail ? (
          <img
            src={getOptimizedImageUrl(review.showThumbnail, 'thumbnail')}
            alt={review.showTitle}
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
      </Link>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            {review.url ? (
              <a href={review.url} target="_blank" rel="noopener noreferrer" className="font-bold text-white hover:text-brand transition-colors truncate block">
                {review.showTitle}
                {showYear && <span className="text-fg-muted font-normal text-sm ml-1">({showYear})</span>}
                <svg className="inline-block w-3 h-3 ml-1 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            ) : (
              <Link href={`/show/${review.showSlug}`} className="font-bold text-white hover:text-brand transition-colors truncate block">
                {review.showTitle}
                {showYear && <span className="text-fg-muted font-normal text-sm ml-1">({showYear})</span>}
              </Link>
            )}
            <p className="text-gray-400 text-sm truncate">
              {review.outletSlug ? (
                <Link href={`/critics/outlets/${review.outletSlug}`} className="hover:text-brand transition-colors">{review.outlet}</Link>
              ) : review.outlet}
              {review.parsedDate ? ` · ${formatDate(review.parsedDate)}` : ''}
            </p>
          </div>

          {/* Score */}
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(review.reviewScore)} flex items-center justify-center font-bold flex-shrink-0`}>
            {Math.round(review.reviewScore)}
          </div>
        </div>

        {/* Excerpt */}
        {review.quote && (
          <p className="text-fg-muted text-sm mt-2 line-clamp-2 italic leading-relaxed">
            &ldquo;{nestQuotes(review.quote)}&rdquo;
          </p>
        )}
      </div>
    </article>
  );
}

const INITIAL_REVIEWS = 100;

export default function CriticDetailClient({ critic, profile }: { critic: CriticProfile; profile?: PublicCriticProfile | null }) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_REVIEWS);

  const marketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of critic.reviews) {
      const m = r.showCategory || 'broadway';
      counts[m] = (counts[m] || 0) + 1;
    }
    return counts;
  }, [critic.reviews]);

  const availableMarkets = useMemo(() => {
    const order: MarketFilter[] = ['broadway', 'west-end', 'off-west-end', 'off-broadway'];
    return order.filter(m => (marketCounts[m] || 0) >= MARKET_FILTER_MIN) as Exclude<MarketFilter, 'all'>[];
  }, [marketCounts]);

  const showMarketFilter = availableMarkets.length >= 2;
  // Default preference: Broadway > West End > highest-volume remaining.
  // Off-Broadway / Off-West End never default; they require an explicit click.
  const defaultMarket: MarketFilter = (() => {
    if (!showMarketFilter) return 'all';
    if (availableMarkets.includes('broadway')) return 'broadway';
    if (availableMarkets.includes('west-end')) return 'west-end';
    return availableMarkets[0];
  })();
  const [marketFilter, setMarketFilter] = useState<MarketFilter>(defaultMarket);

  const filteredReviews = useMemo(() => {
    if (marketFilter === 'all') return critic.reviews;
    return critic.reviews.filter(r => (r.showCategory || 'broadway') === marketFilter);
  }, [critic.reviews, marketFilter]);

  const filteredStats = useMemo(() => {
    if (marketFilter === 'all') {
      return { count: critic.reviewCount, avg: critic.avgScore, high: critic.highScore, low: critic.lowScore };
    }
    const scores = filteredReviews.map(r => r.reviewScore);
    if (scores.length === 0) return { count: 0, avg: 0, high: 0, low: 0 };
    return {
      count: scores.length,
      avg: scores.reduce((s, n) => s + n, 0) / scores.length,
      high: Math.max(...scores),
      low: Math.min(...scores),
    };
  }, [marketFilter, filteredReviews, critic]);

  // Detect show titles that appear multiple times (different productions)
  const duplicateTitles = useMemo(() => {
    const titleCounts = new Map<string, number>();
    for (const r of filteredReviews) {
      titleCounts.set(r.showTitle, (titleCounts.get(r.showTitle) || 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [title, count] of Array.from(titleCounts)) {
      if (count > 1) dupes.add(title);
    }
    return dupes;
  }, [filteredReviews]);

  const sortedReviews = useMemo(() => {
    const sorted = [...filteredReviews];
    if (sortMode === 'recent') {
      sorted.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));
    } else if (sortMode === 'highest') {
      sorted.sort((a, b) => b.reviewScore - a.reviewScore);
    } else {
      sorted.sort((a, b) => a.reviewScore - b.reviewScore);
    }
    return sorted;
  }, [filteredReviews, sortMode]);

  // Count a view for verified critics (once per browser tab session; no visitor data is sent).
  useEffect(() => {
    if (!profile) return;
    try {
      const k = `critic-view:${critic.slug}`;
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, '1');
    } catch { /* storage blocked: count anyway */ }
    fetch('/api/critics/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: critic.slug }), keepalive: true }).catch(() => {});
  }, [profile, critic.slug]);

  const pinnedReview = useMemo(
    () => (profile?.pinnedReviewKey ? critic.reviews.find(r => `${r.showSlug}-${getReviewKey(r)}` === profile.pinnedReviewKey) : undefined),
    [critic.reviews, profile?.pinnedReviewKey],
  );
  const visibleReviews = sortedReviews.slice(0, showCount);
  const remaining = sortedReviews.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Critics', href: '/critics' },
        { label: critic.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0 overflow-hidden">
            <AvatarImage
              src={profile?.photoUrl}
              className="w-full h-full object-cover"
              fallback={<span className="text-white font-bold text-lg">{getInitials(critic.name)}</span>}
            />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2 flex-wrap">
              {critic.name}
              {profile && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand text-gray-900 align-middle">&#10003; Verified critic</span>
              )}
            </h1>
            {profile?.jobTitle && <p className="text-sm text-fg-muted">{profile.jobTitle}</p>}
            <div className="flex items-center gap-2 text-sm text-gray-400">
              {critic.outlets[0] && (
                <Link href={`/critics/outlets/${critic.reviews.find(r => r.outlet === critic.outlets[0])?.outletSlug || ''}`} className="hover:text-brand transition-colors">
                  {critic.primaryOutlet}
                </Link>
              )}
              {critic.isFreelancer && (
                <span className="text-xs font-medium px-1.5 py-0.5 rounded border bg-purple-500/20 text-purple-400 border-purple-500/30">
                  Freelancer
                </span>
              )}
            </div>
          </div>
        </div>

        <CriticClaimPanel
          slug={critic.slug}
          name={critic.name}
          outlet={critic.primaryOutlet}
          claimed={!!profile}
          reviewOptions={critic.reviews.map(r => ({ key: `${r.showSlug}-${getReviewKey(r)}`, label: `${r.showTitle} (${r.outlet})` }))}
        />

        {/* Bio: the critic's own when verified, else the hand-written one (src/config/critic-bios.ts) */}
        {(profile?.bio || getCriticBio(critic.slug)) && (
          <p className="text-fg-muted text-sm mb-4">{profile?.bio || getCriticBio(critic.slug)}</p>
        )}

        {profile && profile.links.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {profile.links.map(l => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="inline-flex items-center text-xs px-3 py-1 rounded-full border border-white/10 bg-surface-raised text-white hover:text-brand transition-colors">{l.label}</a>
            ))}
          </div>
        )}

        {profile && (profile.picks.bestEver || profile.picks.thisSeason) && (
          <div className="mb-4 rounded-lg border border-white/10 bg-surface-raised px-4 py-3">
            <h2 className="text-xs uppercase tracking-wide text-fg-muted mb-2">In their own words</h2>
            <dl className="space-y-1 text-sm">
              {profile.picks.bestEver && <div className="flex gap-2"><dt className="text-fg-muted shrink-0">Best ever:</dt><dd className="text-white">{profile.picks.bestEver}</dd></div>}
              {profile.picks.thisSeason && <div className="flex gap-2"><dt className="text-fg-muted shrink-0">This season:</dt><dd className="text-white">{profile.picks.thisSeason}</dd></div>}
            </dl>
          </div>
        )}

        {/* All outlets if multi */}
        {critic.outlets.length > 1 && (
          <p className="text-fg-muted text-sm mb-4">
            Also writes for: {critic.outlets.filter(o => o !== critic.primaryOutlet).map((o, i, arr) => {
              const outletReview = critic.reviews.find(r => r.outlet === o);
              const slug = outletReview?.outletSlug || '';
              return (
                <span key={o}>
                  {slug ? <Link href={`/critics/outlets/${slug}`} className="hover:text-brand transition-colors">{o}</Link> : o}
                  {i < arr.length - 1 ? ', ' : ''}
                </span>
              );
            })}
          </p>
        )}

        {/* Stats */}
        <StatGrid className="mb-4" stats={[
          { label: 'Reviews', value: filteredStats.count },
          { label: 'Average', value: Math.round(filteredStats.avg), color: getScoreTextColor(filteredStats.avg) },
          { label: 'Highest', value: filteredStats.high },
          { label: 'Lowest', value: filteredStats.low },
        ]} />

        {/* Ranks */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(critic.volumeRank)} most prolific critic</span>
          <span aria-hidden="true" className="text-white/25">·</span>
          <span>{ordinalSuffix(critic.generosityRank)} most generous scorer</span>
          {marketFilter !== 'all' && (
            <span className="text-fg-muted">· ranks across all reviews</span>
          )}
        </div>
      </div>

      {/* Market Filter — only when critic spans 2+ markets with ≥3 reviews each */}
      {showMarketFilter && (
        <ToggleBar
          label="MARKET:"
          options={[
            { value: 'all' as MarketFilter, label: `ALL (${critic.reviewCount})` },
            ...availableMarkets.map(m => ({
              value: m as MarketFilter,
              label: `${MARKET_LABELS[m].toUpperCase()} (${marketCounts[m]})`,
            })),
          ]}
          value={marketFilter}
          onChange={(m) => { setMarketFilter(m); setShowCount(INITIAL_REVIEWS); }}
          ariaLabel="Filter by market"
          size="compact"
          className="mb-3"
        />
      )}

      {/* Sort Controls */}
      <ToggleBar
        label="SORT:"
        options={[
          { value: 'recent' as SortMode, label: 'RECENT' },
          { value: 'highest' as SortMode, label: 'HIGHEST' },
          { value: 'lowest' as SortMode, label: 'LOWEST' },
        ]}
        value={sortMode}
        onChange={(mode) => { setSortMode(mode); setShowCount(INITIAL_REVIEWS); }}
        ariaLabel="Sort reviews"
        size="compact"
        className="mb-4"
      />

      {pinnedReview && (
        <div className="mb-4">
          <h2 className="text-xs uppercase tracking-wide text-fg-muted mb-2">Pinned review</h2>
          <ReviewCard review={pinnedReview} showYear={null} loading="lazy" />
        </div>
      )}

      {/* Review List */}
      <div className="space-y-2">
        {visibleReviews.length > 0 ? (
          visibleReviews.map((review, index) => (
            <ReviewCard key={`${review.showSlug}-${getReviewKey(review)}`} review={review} showYear={duplicateTitles.has(review.showTitle) ? getShowYear(review) : null} loading={index < 4 ? 'eager' : 'lazy'} />
          ))
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No reviews found for this critic.</p>
          </div>
        )}
      </div>

      {/* Show More */}
      {remaining > 0 && (
        <button
          onClick={() => setShowCount(prev => prev + 100)}
          className="mt-4 w-full py-3 text-sm text-gray-400 hover:text-white border border-white/10 rounded-lg hover:bg-surface-overlay transition-colors"
        >
          Show {Math.min(remaining, 100)} more review{remaining === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
