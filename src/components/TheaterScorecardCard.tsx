'use client';

import Link from 'next/link';
import type { TheaterVenueScores, TheaterAccessibility, TheaterExternalLinks } from '@/lib/data-types';
import { featureFlags } from '@/config/feature-flags';

interface TheaterScorecardCardProps {
  venueScores: TheaterVenueScores;
  accessibility?: TheaterAccessibility;
  externalLinks?: TheaterExternalLinks;
  theaterName: string;
  theaterSlug: string;
}

const DIMENSIONS: { key: keyof Pick<TheaterVenueScores, 'sightlines' | 'sound' | 'comfort' | 'ambiance' | 'facilities'>; label: string; icon: JSX.Element }[] = [
  { key: 'sightlines', label: 'Sightlines', icon: <EyeIcon /> },
  { key: 'sound', label: 'Sound', icon: <SoundIcon /> },
  { key: 'comfort', label: 'Comfort', icon: <ComfortIcon /> },
  { key: 'ambiance', label: 'Ambiance', icon: <SparkleIcon /> },
  { key: 'facilities', label: 'Restrooms', icon: <FacilitiesIcon /> },
];

function getScoreColor(score: number): string {
  if (score >= 4) return 'bg-emerald-500';
  if (score >= 3) return 'bg-amber-500';
  return 'bg-red-400';
}

function getScoreTextColor(score: number): string {
  if (score >= 4) return 'text-emerald-400';
  if (score >= 3) return 'text-amber-400';
  return 'text-red-400';
}

function getScoreLabel(score: number): string {
  if (score >= 5) return 'Excellent';
  if (score >= 4) return 'Good';
  if (score >= 3) return 'Average';
  if (score >= 2) return 'Below Avg';
  return 'Poor';
}

// Icons
function EyeIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M12 6.253v11.494m-3.536-1.322a5 5 0 010-7.072M6.343 6.343A8 8 0 1017.657 17.657" />
    </svg>
  );
}

function ComfortIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19h16M5 7a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H7a2 2 0 01-2-2V7zm2 0v8h10V7H7z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
    </svg>
  );
}

function FacilitiesIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  );
}

function WheelchairIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a3 3 0 100 6 3 3 0 000-6zm-1 8a5 5 0 00-4.9 4H4a1 1 0 100 2h2.1A5 5 0 0016 16h3l1.4 4.2a1 1 0 101.9-.6L20.7 15a1 1 0 00-.9-.7L16 14a3 3 0 01-3-3V10h-2z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function ScoreDots({ score, label, icon }: { score: number; label: string; icon: JSX.Element }) {
  return (
    <div className="flex items-center gap-2" role="meter" aria-valuenow={score} aria-valuemin={1} aria-valuemax={5} aria-label={`${label}: ${score} out of 5`}>
      <div className="flex items-center gap-1.5 w-24 sm:w-28 flex-shrink-0">
        <span className={getScoreTextColor(score)}>{icon}</span>
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(i => (
          <div
            key={i}
            className={`w-5 h-5 sm:w-[22px] sm:h-[22px] rounded ${i <= score ? getScoreColor(score) : 'bg-white/[0.06]'}`}
          />
        ))}
      </div>
      <span className={`text-xs font-medium text-gray-500 ml-1`}>{score}/5</span>
    </div>
  );
}

export default function TheaterScorecardCard({
  venueScores,
  accessibility,
  externalLinks,
  theaterName,
  theaterSlug,
}: TheaterScorecardCardProps) {
  // Feature flag check must live here (client component) — not in the SSR parent
  if (!featureFlags.theaterScorecard) return null;

  // Don't render if no scores
  if (!venueScores.sightlines && !venueScores.sound && !venueScores.comfort && !venueScores.ambiance && !venueScores.facilities) {
    return null;
  }

  const overall = venueScores.overall;

  return (
    <section className="card p-4 sm:p-5 mb-8" aria-labelledby="theater-scorecard-heading">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 id="theater-scorecard-heading" className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Theater Scorecard</h2>
          <Link href={`/theater/${theaterSlug}`} className="text-white font-bold hover:text-brand transition-colors text-base">
            {theaterName}
          </Link>
        </div>
        {overall != null && (
          <div className="flex flex-col items-center flex-shrink-0 ml-3">
            <div className={`w-11 h-11 rounded-lg flex items-center justify-center font-bold text-lg ${
              overall >= 4 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
              overall >= 3 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
              'bg-red-500/20 text-red-400 border border-red-500/30'
            }`}>
              {overall.toFixed(1)}
            </div>
            <span className="text-[9px] text-gray-500 mt-0.5">{getScoreLabel(Math.round(overall))}</span>
          </div>
        )}
      </div>

      {/* Summary */}
      {venueScores.summary && (
        <p className="text-sm text-gray-300 leading-relaxed mb-4">{venueScores.summary}</p>
      )}

      {/* Score pips */}
      <div className="space-y-2.5 mb-4">
        {DIMENSIONS.map(({ key, label, icon }) => {
          const score = venueScores[key];
          if (score == null) return null;
          return <ScoreDots key={key} score={score} label={label} icon={icon} />;
        })}
      </div>

      {/* Accessibility badges */}
      {accessibility && accessibility.verified && (
        <div className="border-t border-white/5 pt-3 mb-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">Accessibility</p>
          <div className="flex flex-wrap gap-1.5">
            {accessibility.wheelchair && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-medium border border-blue-500/20">
                <WheelchairIcon /> Wheelchair
              </span>
            )}
            {accessibility.elevator && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-medium border border-blue-500/20">
                Elevator
              </span>
            )}
            {accessibility.hearingLoop && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-medium border border-blue-500/20">
                Hearing Loop
              </span>
            )}
            {accessibility.assistiveListening && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-medium border border-blue-500/20">
                Assistive Listening
              </span>
            )}
          </div>
          {accessibility.notes && (
            <p className="text-xs text-gray-500 mt-1.5">{accessibility.notes}</p>
          )}
        </div>
      )}

      {/* External links */}
      {externalLinks && (externalLinks.seatplan || externalLinks.aviewfrommyseat) && (
        <div className="border-t border-white/5 pt-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">Find Your Seat</p>
          <div className="flex flex-wrap gap-2">
            {externalLinks.seatplan && (
              <a
                href={externalLinks.seatplan}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors"
              >
                SeatPlan <ExternalLinkIcon />
              </a>
            )}
            {externalLinks.aviewfrommyseat && (
              <a
                href={externalLinks.aviewfrommyseat}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors"
              >
                A View From My Seat <ExternalLinkIcon />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Methodology note */}
      <p className="text-[9px] text-gray-600 mt-3 leading-relaxed">
        Venue ratings based on audience reviews from SeatPlan, A View From My Seat, and community feedback.
      </p>
    </section>
  );
}
