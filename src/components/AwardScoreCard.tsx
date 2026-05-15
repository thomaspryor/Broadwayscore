'use client';

import { useState } from 'react';
import Link from 'next/link';
import { computeSiteAwardScore, type CeremonyContribution } from '@/lib/awards-scoring';
import type { ShowAwards } from '@/lib/data-types';
import { TrophyIcon, StarIcon, ChevronIcon, PulitzerIcon } from '@/components/icons';
import { sortByImportance } from '@/config/awards';
import { AwardScoreBadge, AWARD_TIER_LABEL } from '@/components/show-cards';
import { featureFlags } from '@/config/feature-flags';

interface AwardScoreCardProps {
  showId: string;
  awards: ShowAwards | undefined;
  openingDate?: string;
}

function toFullSeasonLabel(season: string): string {
  const parts = season.split('-');
  if (parts.length !== 2) return season;
  const endPart = parseInt(parts[1], 10);
  const fullEnd = endPart < 100 ? 2000 + endPart : endPart;
  return `${parts[0]}-${fullEnd}`;
}

function buildSublabel(awards: ShowAwards | undefined, badge: string, inProgress: boolean): string {
  const tonyWins = awards?.tony?.wins?.length ?? 0;
  const tonyNoms = awards?.tony?.nominations ?? 0;
  if (badge === 'sweeper' && tonyWins > 0) {
    const top = sortByImportance(awards?.tony?.wins ?? [])[0];
    return tonyWins > 1 ? `Won ${top} + ${tonyWins - 1} more` : `Won ${top}`;
  }
  if (badge === 'decorated' && tonyWins > 0) return `${tonyWins} Tony win${tonyWins === 1 ? '' : 's'}`;
  if (badge === 'honored' && tonyWins > 0) {
    const top = sortByImportance(awards?.tony?.wins ?? [])[0];
    return `Won ${top}`;
  }
  if (inProgress) return 'Awards season in progress';
  if (tonyNoms > 0) return `${tonyNoms} Tony nomination${tonyNoms === 1 ? '' : 's'}`;
  return 'Eligible for awards';
}

function tierIconColor(tier: string): string {
  if (tier === 'S') return 'text-amber-400';
  if (tier === 'A+' || tier === 'A') return 'text-violet-300';
  if (tier === 'B') return 'text-emerald-300';
  return 'text-gray-400';
}

function BreakdownSection({ breakdown }: { breakdown: CeremonyContribution[] }) {
  return (
    <div className="space-y-4 text-sm">
      {breakdown.filter(c => c.subtotal > 0).map((c, ci) => (
        <div key={ci}>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{c.ceremony}</span>
            <span className="text-gray-400 tabular-nums">+{Math.round(c.subtotal)}</span>
          </div>
          <ul className="space-y-1 pl-2">
            {c.items.map((it, ii) => (
              <li key={ii} className="flex items-center gap-2">
                {it.result === 'win'
                  ? <TrophyIcon className={`w-3 h-3 flex-shrink-0 ${tierIconColor(it.tier)}`} />
                  : <StarIcon className="w-3 h-3 text-gray-500 flex-shrink-0" />}
                <span className={`flex-1 truncate ${it.result === 'win' ? 'text-gray-300' : 'text-gray-500'}`}>
                  {it.category}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-gray-500 tabular-nums">+{Math.round(it.points)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function AwardScoreCard({ showId, awards, openingDate }: AwardScoreCardProps) {
  const [expanded, setExpanded] = useState(false);
  const result = computeSiteAwardScore(showId, 'broadway');

  // Hide entirely for historical no-data shows (matches legacy AwardsCard behavior).
  if (result.displayScore === 0 && !result.inProgress) {
    const openingMs = openingDate ? new Date(openingDate).getTime() : 0;
    const monthsSinceOpening = openingMs ? (Date.now() - openingMs) / (30 * 24 * 60 * 60 * 1000) : Infinity;
    if (monthsSinceOpening > 14) return null;
  }

  const isPulitzerWinner = !!awards?.pulitzer?.wins?.includes('Drama');
  const isPulitzerFinalist = !!awards?.pulitzer?.finalist?.includes('Drama') || !!awards?.pulitzerFinalist;
  const hasPulitzer = isPulitzerWinner || isPulitzerFinalist;
  const pulitzerYear = awards?.pulitzer?.year ?? awards?.pulitzerFinalist?.year;
  const tonySeason = awards?.tony?.season;

  const tierLabel = result.inProgress && result.badge === 'nominated' ? 'In the Hunt' : AWARD_TIER_LABEL[result.badge];
  const sublabel = buildSublabel(awards, result.badge, result.inProgress);

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards Scorecard</h2>

      {/* Hero row — matches existing card pattern (badge + tier label + sublabel) */}
      <div className="flex items-center gap-4 mb-4">
        <AwardScoreBadge score={result.displayScore} badge={result.badge} inProgress={result.inProgress} size="lg" />
        <div className="min-w-0">
          <div className="text-lg font-bold text-white">{tierLabel}</div>
          <div className="text-sm text-gray-400">{sublabel}</div>
          {result.inProgress && result.displayScore > 0 && (
            <div className="text-xs text-gray-500 mt-1">*Score so far — season in progress</div>
          )}
        </div>
      </div>

      {/* Pulitzer special callout — kept from the legacy card */}
      {hasPulitzer && (
        <div
          className={
            isPulitzerWinner
              ? 'bg-gradient-to-r from-amber-500/10 to-yellow-500/10 rounded-lg p-3 border border-amber-500/20 mb-4'
              : 'bg-amber-500/5 rounded-lg p-3 border border-amber-500/15 mb-4'
          }
        >
          <div className="flex items-center gap-2">
            <PulitzerIcon className={isPulitzerWinner ? 'text-amber-400' : 'text-amber-400/70'} />
            <span className={isPulitzerWinner ? 'text-amber-300 font-medium' : 'text-amber-200/80'}>
              Pulitzer Prize for Drama{isPulitzerWinner ? ' Winner' : ' Finalist'}
              {typeof pulitzerYear === 'number' ? ` (${pulitzerYear})` : ''}
            </span>
          </div>
        </div>
      )}

      {/* Score breakdown — matches Tony Stats Summary panel pattern */}
      {result.displayScore > 0 && (
        <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between text-left group"
            aria-expanded={expanded}
          >
            <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
              How the score is built
            </span>
            <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
          </button>
          {expanded && (
            <div className="mt-4 border-t border-white/5 pt-3">
              <BreakdownSection breakdown={result.breakdown} />
              <div className="mt-3 text-xs text-gray-500 tabular-nums">
                Raw points {Math.round(result.rawPoints)} · log-scaled to {result.displayScore}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty-state copy when nothing has happened yet but show is current-season */}
      {result.displayScore === 0 && result.inProgress && (
        <p className="text-sm text-gray-400">
          No awards recognition yet this season. First nominations land in late April.
        </p>
      )}

      {/* Cross-link to Tony Predictions — kept from legacy card */}
      {featureFlags.tonyPredictions && tonySeason && (
        <div className="border-t border-white/5 pt-3 mt-4">
          <Link
            href={`/tony-awards/predictions/${toFullSeasonLabel(tonySeason)}`}
            className="text-sm text-brand hover:text-brand-hover transition-colors"
          >
            See {tonySeason} Tony predictions &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}
