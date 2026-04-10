'use client';

import {
  getAudienceGrade,
  getAudienceGradeClasses,
  getTotalAudienceReviews,
} from '@/lib/audience-grade-utils';
import type { AudienceBuzzData } from '@/lib/data-types';
import { AUDIENCE_SOURCES, type AudienceSourceConfig } from '@/config/audience-sources';

interface AudienceBuzzCardProps {
  buzz: AudienceBuzzData;
  showScoreUrl?: string;
  limitedSources?: boolean;
  market?: 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end';
  /** Pre-computed URLs for each audience platform (keyed by source key) */
  platformUrls?: Record<string, string>;
}

// Heart icon for "Loving It"
function HeartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
    </svg>
  );
}

// Thumbs up icon for "Liking It"
function ThumbsUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
    </svg>
  );
}

// Meh/shrug icon for "Take-it-or-Leave-it"
function MehIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-4-8c.79 0 1.5-.71 1.5-1.5S8.79 9 8 9s-1.5.71-1.5 1.5S7.21 12 8 12zm8 0c.79 0 1.5-.71 1.5-1.5S16.79 9 16 9s-1.5.71-1.5 1.5.71 1.5 1.5 1.5zm-4 4c-2 0-4-1-4-1v1s2 1 4 1 4-1 4-1v-1s-2 1-4 1z"/>
    </svg>
  );
}

// Thumbs down icon for "Loathing It"
function ThumbsDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/>
    </svg>
  );
}

// Show Score icon (bar chart — audience scoring platform)
function ShowScoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <rect x="1" y="9" width="3" height="6" rx="0.5"/>
      <rect x="6" y="5" width="3" height="10" rx="0.5"/>
      <rect x="11" y="1" width="3" height="14" rx="0.5"/>
    </svg>
  );
}

// Mezzanine icon (theater seats)
function MezzanineIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM8 20H4v-4h4v4zm0-6H4v-4h4v4zm6 6h-4v-4h4v4zm0-6h-4v-4h4v4zm6 6h-4v-4h4v4zm0-6h-4v-4h4v4z"/>
    </svg>
  );
}

// Reddit icon
function RedditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/>
    </svg>
  );
}

// Theatr icon (thumbs up — their core sentiment is likes/dislikes/mixed)
function TheatrIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
    </svg>
  );
}

// Broadway.com icon (star — verified ticket buyer star ratings)
function BroadwayComIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  );
}

// External link icon
function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function formatReviewCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

interface SourceCardProps {
  name: string;
  icon: React.ReactNode;
  score: number;
  reviewCount: number | null;
  starRating?: number;
  url?: string;
  volumeLabel?: string;
}

function SourceCard({ name, icon, score, reviewCount, starRating, url, volumeLabel }: SourceCardProps) {
  const inner = (
    <>
      <div className="flex items-center gap-1.5 mb-2 min-w-0">
        <span className="shrink-0">{icon}</span>
        <span className="text-[10px] sm:text-xs font-medium text-gray-400 uppercase tracking-wide leading-tight">{name}</span>
      </div>
      <div className="text-xl font-bold text-white">
        {starRating != null ? `${starRating}/5` : `${score}%`}
      </div>
      {reviewCount !== null && (
        <div className="flex items-center gap-1 text-xs text-gray-500 mt-0.5">
          {formatReviewCount(reviewCount)} {volumeLabel || 'reviews'}
          {url && <ExternalLinkIcon className="text-gray-500" />}
        </div>
      )}
    </>
  );

  const className = `bg-surface-overlay rounded-lg p-3 border border-white/5 hover:bg-white/5 transition-colors ${url ? 'hover:border-white/10' : ''}`;

  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }

  return <div className={className}>{inner}</div>;
}

const SOURCE_ICONS: Record<string, (props: { className?: string }) => React.ReactNode> = {
  showScore: ShowScoreIcon, mezzanine: MezzanineIcon, seatplan: ShowScoreIcon,
  lbo: BroadwayComIcon, ltd: BroadwayComIcon, theatr: TheatrIcon, broadwayCom: BroadwayComIcon, reddit: RedditIcon,
};

export default function AudienceBuzzCard({ buzz, showScoreUrl, limitedSources, market, platformUrls }: AudienceBuzzCardProps) {
  const grade = getAudienceGrade(buzz.combinedScore);
  const colors = getAudienceGradeClasses(buzz.combinedScore);
  const visibleSources = market ? AUDIENCE_SOURCES.filter(s => s.markets.includes(market)) : AUDIENCE_SOURCES;

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Audience Grade</h2>

      {/* Main Grade Badge */}
      <div className={`rounded-xl p-4 border mb-4 ${colors.bgClass} ${colors.borderClass}`}>
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-lg flex items-center justify-center font-bold text-xl shadow-sm${grade.grade === 'A+' ? ' audience-top-grade' : ''}`}
            style={grade.grade === 'A+' ? {} : {
              backgroundColor: grade.color,
              color: grade.textColor,
              boxShadow: `0 2px 8px ${grade.color}4d`,
            }}
          >
            {grade.grade}
          </div>
          <div>
            <div className={`text-lg font-bold ${colors.textClass}`}>{grade.label}</div>
            <div className="text-sm text-gray-400">
              Based on {formatReviewCount(getTotalAudienceReviews(buzz))} audience reviews
            </div>
          </div>
        </div>
      </div>

      {/* Source Cards Grid — wraps to 2 rows when 4+ sources */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {visibleSources.map(src => {
          const data = buzz.sources[src.key];
          if (!data || data.score == null) return null;
          // Per-source minimum-volume gates (mirrors scripts/lib/audience-weighting.js
          // and generate-mobile-show-details.js). Without these, sources with too
          // little signal render as misleading "100% / 1 vote" cards.
          if (src.key === 'theatr' && (data.reviewCount || 0) < 10) return null;
          const IconComponent = SOURCE_ICONS[src.key] || ShowScoreIcon;
          const url = src.key === 'showScore'
            ? showScoreUrl
            : platformUrls?.[src.key];
          return (
            <SourceCard
              key={src.key}
              name={src.shortName || src.name}
              icon={<IconComponent className={src.iconColor} />}
              score={data.score}
              reviewCount={data.reviewCount ?? null}
              starRating={src.showStarRating ? data.starRating : undefined}
              url={url}
              volumeLabel={src.volumeLabel}
            />
          );
        })}
      </div>

      {/* Limited sources note for historical shows */}
      {limitedSources && (
        <p className="text-xs text-gray-500 mt-3">
          This show predates most audience rating platforms. Score based on limited sources.
        </p>
      )}
    </div>
  );
}
