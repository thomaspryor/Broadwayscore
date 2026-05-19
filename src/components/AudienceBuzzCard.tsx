'use client';

import Link from 'next/link';
import {
  getAudienceGrade,
  getTotalAudienceReviews,
} from '@/lib/audience-grade-utils';
import type { AudienceBuzzData } from '@/lib/data-types';
import type { ShowRanks } from '@/lib/data-show-ranks';
import { AUDIENCE_SOURCES } from '@/config/audience-sources';
import HeroRankLine from '@/components/show-page/HeroRankLine';

interface AudienceBuzzCardProps {
  buzz: AudienceBuzzData;
  showScoreUrl?: string;
  limitedSources?: boolean;
  market?: 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end';
  /** Pre-computed URLs for each audience platform (keyed by source key) */
  platformUrls?: Record<string, string>;
  /** Cross-show rank set. When provided, renders an audience rank line
   *  (open-market / season / all-time) in the hero. Null hides the line. */
  ranks?: ShowRanks | null;
}

function formatReviewCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

// Map each source key to a Tailwind text-color class for its label. Mirrors
// the platform palette used elsewhere in the app (matches iconColor in the
// AUDIENCE_SOURCES config). The label color is what tells the eye which
// platform a tile belongs to now that we no longer show platform icons.
const SOURCE_LABEL_COLOR: Record<string, string> = {
  showScore:   'text-yellow-400',
  mezzanine:   'text-purple-400',
  seatplan:    'text-cyan-400',
  lbo:         'text-emerald-400',
  ltd:         'text-rose-400',
  theatr:      'text-teal-400',
  broadwayCom: 'text-blue-400',
  reddit:      'text-orange-400',
};

interface SourceTileProps {
  shortLabel: string;
  labelColorClass: string;
  value: string;
  sub: string | null;
  url?: string;
}

function SourceTile({ shortLabel, labelColorClass, value, sub, url }: SourceTileProps) {
  const inner = (
    <>
      <div
        className={`text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.1em] leading-none ${labelColorClass}`}
      >
        {shortLabel}
      </div>
      <div className="mt-1.5 text-2xl font-extrabold tabular-nums tracking-tight leading-none text-white">
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
          {sub}
        </div>
      )}
    </>
  );

  const className =
    'flex flex-col items-center justify-center text-center bg-surface-overlay border border-white/5 rounded-[10px] px-3 py-3.5 transition-colors';

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:bg-white/5 hover:border-white/10`}
      >
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}

function audienceBuzzLinkForMarket(
  market?: AudienceBuzzCardProps['market']
): string | null {
  // Only Broadway and West End have published audience-buzz aggregate pages
  // today. Off-Broadway and Off-West End fall back to the closest market's
  // page (it still includes their shows) so the footer link is always useful.
  if (market === 'west-end' || market === 'off-west-end') return '/west-end/audience-buzz';
  return '/audience-buzz';
}

export default function AudienceBuzzCard({
  buzz,
  showScoreUrl,
  limitedSources,
  market,
  platformUrls,
  ranks,
}: AudienceBuzzCardProps) {
  const totalReviews = getTotalAudienceReviews(buzz);
  const grade = getAudienceGrade(buzz.combinedScore);
  const visibleSources = market
    ? AUDIENCE_SOURCES.filter((s) => s.markets.includes(market))
    : AUDIENCE_SOURCES;

  const renderedTiles = visibleSources
    .map((src) => {
      const data = buzz.sources[src.key];
      if (!data || data.score == null) return null;
      // Per-source minimum-volume gates (mirrors scripts/lib/audience-weighting.js
      // and generate-mobile-show-details.js). Without these, sources with too
      // little signal render as misleading "100% / 1 vote" cards.
      if (src.key === 'theatr' && (data.reviewCount || 0) < 10) return null;

      const value =
        src.showStarRating && data.starRating != null
          ? `${data.starRating}/5`
          : `${data.score}%`;
      const sub =
        data.reviewCount != null
          ? `${formatReviewCount(data.reviewCount)} ${src.volumeLabel}`
          : null;
      const url = src.key === 'showScore' ? showScoreUrl : platformUrls?.[src.key];

      return (
        <SourceTile
          key={src.key}
          shortLabel={src.shortName || src.name}
          labelColorClass={SOURCE_LABEL_COLOR[src.key] || 'text-gray-400'}
          value={value}
          sub={sub}
          url={url}
        />
      );
    })
    .filter(Boolean);

  // A+ shows get a subtle gradient + glow on the grade badge via the
  // .audience-top-grade class (lives in globals.css). All other grades use
  // the flat tier color from getAudienceGrade().
  const isTopGrade = grade.grade === 'A+';
  const badgeStyle = isTopGrade
    ? undefined
    : {
        backgroundColor: grade.color,
        color: grade.textColor,
        boxShadow: `0 2px 8px ${grade.color}4d`,
      };

  const audienceBuzzHref = audienceBuzzLinkForMarket(market);
  // Subtitle slot under the tier name shows the audience rank line when
  // ranks data is available. The redundant "aggregated from X reviews
  // across N platforms" text was dropped — the meta count + tile grid
  // already convey both numbers.
  const audienceRanks = ranks?.audience;
  const hasAudienceRank = !!(audienceRanks && (audienceRanks.openMarket || audienceRanks.season || audienceRanks.allTime));

  return (
    <section
      id="audience"
      className="card p-5 sm:p-6 mb-8"
      aria-labelledby="audience-scorecard-heading"
    >
      {/* Header: eyebrow on left, lowercase meta count on right */}
      <header className="flex items-center justify-between gap-3">
        <h2
          id="audience-scorecard-heading"
          className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0"
        >
          Audience Scorecard
        </h2>
        {totalReviews > 0 && (
          <div className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
            {formatReviewCount(totalReviews)} audience reviews
          </div>
        )}
      </header>

      {/* Hero lockup: tier-colored grade badge + colored title + subtitle.
          No outer colored frame — the badge and title supply the color. */}
      <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-3.5 items-center">
        <div
          className={`w-[72px] h-[72px] sm:w-[88px] sm:h-[88px] rounded-xl flex items-center justify-center font-extrabold tabular-nums shrink-0 text-[28px] sm:text-[32px]${isTopGrade ? ' audience-top-grade' : ''}`}
          style={badgeStyle}
          aria-label={`Audience grade ${grade.grade}: ${grade.label}`}
          title={grade.tooltip}
        >
          {grade.grade}
        </div>
        <div className="min-w-0">
          <div
            className="text-xl sm:text-[1.375rem] font-extrabold uppercase tracking-[0.04em] leading-[1.15]"
            style={{ color: grade.color }}
          >
            {grade.label}
          </div>
          {hasAudienceRank && market && (
            <HeroRankLine
              ranks={ranks ?? null}
              market={market}
              metric="audience"
              className="mt-1"
            />
          )}
        </div>
      </div>

      {/* Divider */}
      {renderedTiles.length > 0 && (
        <div className="h-px bg-white/5 my-4" aria-hidden="true" />
      )}

      {/* Per-platform tile grid (3 cols, wraps to a 2nd row past 3 tiles) */}
      {renderedTiles.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
          {renderedTiles}
        </div>
      )}

      {/* Limited sources note for historical shows */}
      {limitedSources && (
        <p className="text-xs text-gray-500 mt-3">
          This show predates most audience rating platforms. Score based on limited sources.
        </p>
      )}

      {/* Footer link: navigate to the market's audience-buzz aggregate page.
          Uses next/link for client-side navigation (a plain <a> works too
          but does a full page reload). */}
      {audienceBuzzHref && (
        <div className="mt-3 flex items-center justify-between gap-4 flex-wrap">
          <Link
            href={audienceBuzzHref}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
          >
            <span>See all audience scores</span>
            <span
              className="inline-block transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            >
              →
            </span>
          </Link>
        </div>
      )}
    </section>
  );
}
