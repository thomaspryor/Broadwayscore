'use client';

import { useState } from 'react';
import Link from 'next/link';
import { computeSiteAwardScore, type CeremonyContribution } from '@/lib/awards-scoring';
import type { ShowAwards } from '@/lib/data-types';
import { TrophyIcon, StarIcon, ChevronIcon, PulitzerIcon } from '@/components/icons';
import { sortByImportance, isMajorCategory } from '@/config/awards';
import { AwardScoreBadge } from '@/components/show-cards';
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

/** Plain-English headline lines for the "At a glance" section. */
function buildHighlights(awards: ShowAwards | undefined): string[] {
  if (!awards) return [];
  const out: string[] = [];
  const tonyWins = awards.tony?.wins ?? [];
  const tonyTopWin = sortByImportance(tonyWins).find(isMajorCategory);
  if (tonyTopWin) {
    const others = tonyWins.length - 1;
    out.push(others > 0 ? `Tony — ${tonyTopWin} + ${others} more win${others === 1 ? '' : 's'}` : `Tony — ${tonyTopWin}`);
  } else if (tonyWins.length > 0) {
    out.push(`Tony — ${tonyWins.length} win${tonyWins.length === 1 ? '' : 's'}`);
  } else if ((awards.tony?.nominations ?? 0) > 0) {
    out.push(`Tony — ${awards.tony!.nominations} nomination${awards.tony!.nominations === 1 ? '' : 's'}`);
  }
  if (awards.pulitzer?.wins?.includes('Drama')) out.push('Pulitzer Prize for Drama');
  else if (awards.pulitzer?.finalist?.includes('Drama') || awards.pulitzerFinalist) out.push('Pulitzer Prize finalist');
  if ((awards.nyDramaCritics?.wins?.length ?? 0) > 0) {
    out.push(`NY Drama Critics' Circle — ${awards.nyDramaCritics!.wins!.join(', ')}`);
  }
  return out.slice(0, 5);
}

/** Tier-color class for category labels in the breakdown. */
function tierColor(tier: string): string {
  if (tier === 'S') return 'text-amber-300';
  if (tier === 'A+') return 'text-violet-300';
  if (tier === 'A') return 'text-violet-300';
  if (tier === 'B') return 'text-emerald-300';
  return 'text-gray-400';
}

function BreakdownSection({ breakdown }: { breakdown: CeremonyContribution[] }) {
  return (
    <div className="space-y-4 text-sm">
      {breakdown.filter(c => c.subtotal > 0).map((c, ci) => (
        <div key={ci}>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xs uppercase tracking-wide text-gray-400 font-semibold">{c.ceremony}</span>
            <span className="text-gray-300 tabular-nums">+{Math.round(c.subtotal)}</span>
          </div>
          <ul className="space-y-1 pl-2">
            {c.items.map((it, ii) => (
              <li key={ii} className="flex items-center gap-2 text-gray-400">
                {it.result === 'win'
                  ? <TrophyIcon className="w-3 h-3 text-amber-400 flex-shrink-0" />
                  : <StarIcon className="w-3 h-3 text-gray-500 flex-shrink-0" />}
                <span className={`flex-1 truncate ${it.result === 'win' ? tierColor(it.tier) : 'text-gray-500'}`}>
                  {it.category}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-gray-500 tabular-nums">
                  +{Math.round(it.points)}
                </span>
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

  // Hide entirely if score is 0 and the show is long past its eligibility
  // window — historical no-data shows shouldn't render an empty card.
  if (result.displayScore === 0 && !result.inProgress) {
    const openingMs = openingDate ? new Date(openingDate).getTime() : 0;
    const monthsSinceOpening = openingMs ? (Date.now() - openingMs) / (30 * 24 * 60 * 60 * 1000) : Infinity;
    if (monthsSinceOpening > 14) return null;
  }

  const highlights = buildHighlights(awards);
  const isPulitzerWinner = !!awards?.pulitzer?.wins?.includes('Drama');
  const isPulitzerFinalist = !!awards?.pulitzer?.finalist?.includes('Drama') || !!awards?.pulitzerFinalist;
  const hasPulitzer = isPulitzerWinner || isPulitzerFinalist;
  const pulitzerYear = awards?.pulitzer?.year;
  const tonySeason = awards?.tony?.season;

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards Scorecard</h2>

      <AwardScoreBadge score={result.displayScore} badge={result.badge} inProgress={result.inProgress} />

      {/* Pulitzer special callout — kept from the legacy card. Pulitzer is
          culturally distinct (honors the script, not the production) and
          warrants a visible call-out even though its points are in the score. */}
      {hasPulitzer && (
        <div
          className={
            isPulitzerWinner
              ? 'bg-gradient-to-r from-amber-500/10 to-yellow-500/10 rounded-lg p-3 border border-amber-500/20 mt-4'
              : 'bg-amber-500/5 rounded-lg p-3 border border-amber-500/15 mt-4'
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

      {/* At a glance — plain-English highlights for users who don't expand */}
      {highlights.length > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-2">
            {result.inProgress ? 'Recognition so far' : 'At a glance'}
          </div>
          <ul className="space-y-1.5 text-sm">
            {highlights.map((h, i) => (
              <li key={i} className="flex items-center gap-2 text-gray-300">
                <TrophyIcon className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                {h}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty-state copy when nothing has happened yet but show is current-season */}
      {highlights.length === 0 && result.inProgress && (
        <p className="mt-4 text-sm text-gray-400">
          No awards recognition yet this season. First nominations land in late April.
        </p>
      )}

      {/* Expandable line-item breakdown */}
      {result.breakdown.length > 0 && result.displayScore > 0 && (
        <div className="border-t border-white/5 mt-4 pt-3">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between text-left group"
            aria-expanded={expanded}
          >
            <span className="text-sm font-medium text-gray-300">How the score is built</span>
            <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
          </button>
          {expanded && (
            <div className="mt-4">
              <BreakdownSection breakdown={result.breakdown} />
              <div className="mt-3 text-xs text-gray-500 tabular-nums border-t border-white/5 pt-2">
                Raw points {Math.round(result.rawPoints)} · log-scaled to {result.displayScore}
              </div>
            </div>
          )}
        </div>
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
