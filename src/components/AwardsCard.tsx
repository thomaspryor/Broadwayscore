'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  getAwardsDesignation,
  getTonyWinCount,
  getTonyNominationCount,
} from '@/lib/data-awards';
import type { ShowAwards, AwardsDesignation } from '@/lib/data-types';
import { TrophyIcon, StarIcon, ChevronIcon, PulitzerIcon } from '@/components/icons';
import { sortByImportance, isMajorCategory } from '@/config/awards';
import { featureFlags } from '@/config/feature-flags';
import { seasonSlug } from '@/lib/tony-seasons';
import AwardScoreCard from '@/components/AwardScoreCard';

/** Convert short season "2025-26" to full label "2025-2026" for prediction URLs */
function toFullSeasonLabel(season: string): string {
  const parts = season.split('-');
  if (parts.length !== 2) return season;
  const endPart = parseInt(parts[1], 10);
  const fullEnd = endPart < 100 ? 2000 + endPart : endPart;
  return `${parts[0]}-${fullEnd}`;
}

interface AwardsCardProps {
  showId: string;
  awards: ShowAwards | undefined;
  openingDate?: string;
  /** Map of Tony category → [person names] (winners + nominees, name-only).
   *  Computed server-side from data/tony-nominations.json. Optional so the
   *  legacy v1 path keeps compiling; v2 (AwardScoreCard) uses it to surface
   *  performer/creative names subtly inline. */
  tonyNamesByCategory?: Record<string, string[]>;
}

// Designation config with better labels
const DESIGNATION_CONFIG: Record<AwardsDesignation, {
  label: string;
  sublabel: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}> = {
  'sweeper': {
    label: 'Awards Sweeper',
    sublabel: 'Dominated the Tony Awards',
    bgClass: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/30',
  },
  'lavished': {
    label: 'Award Darling',
    sublabel: 'Multiple Tony wins',
    bgClass: 'bg-gradient-to-r from-violet-500/15 to-purple-500/15',
    textClass: 'text-violet-400',
    borderClass: 'border-violet-500/30',
  },
  'recognized': {
    label: 'Award Winner',
    sublabel: 'Tony winner',
    bgClass: 'bg-emerald-500/10',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/20',
  },
  'nominated': {
    label: 'Tony Nominated',
    sublabel: 'Nominated for Tony Awards',
    bgClass: 'bg-blue-500/10',
    textClass: 'text-blue-400',
    borderClass: 'border-blue-500/20',
  },
  'shut-out': {
    label: 'No Nominations',
    sublabel: 'Eligible but not nominated',
    bgClass: 'bg-gray-500/10',
    textClass: 'text-gray-400',
    borderClass: 'border-white/10',
  },
  'pre-season': {
    label: 'Awaiting Eligibility',
    sublabel: 'Not yet eligible for awards',
    bgClass: 'bg-surface-overlay/30',
    textClass: 'text-gray-500',
    borderClass: 'border-white/10',
  },
  'ineligible': {
    label: 'Not Tony-Eligible',
    sublabel: 'Ruled ineligible by the Tony Administration Committee',
    bgClass: 'bg-surface-overlay/30',
    textClass: 'text-gray-400',
    borderClass: 'border-white/10',
  },
};

// Combined Tony Awards item (win or nomination)
interface TonyItem {
  category: string;
  isWin: boolean;
}

// Combined expandable section for Tony wins and nominations
function TonyExpandableSection({
  wins,
  nominations,
  defaultExpanded = false
}: {
  wins: string[];
  nominations: string[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Combine and sort - wins first, then nominations, both sorted by importance
  const sortedWins = sortByImportance(wins);
  const sortedNoms = sortByImportance(nominations);

  const items: TonyItem[] = [
    ...sortedWins.map(cat => ({ category: cat, isWin: true })),
    ...sortedNoms.map(cat => ({ category: cat, isWin: false })),
  ];

  if (items.length === 0) return null;

  const totalCount = items.length;

  return (
    <div className="border-t border-white/5 pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
      >
        <span className="text-sm font-medium text-gray-300">
          See all categories ({totalCount})
        </span>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-center gap-2 text-sm">
              {item.isWin ? (
                <TrophyIcon className="text-amber-400 flex-shrink-0" />
              ) : (
                <StarIcon className="text-gray-500 flex-shrink-0" />
              )}
              <span className={
                item.isWin
                  ? (isMajorCategory(item.category) ? 'text-white font-medium' : 'text-amber-200')
                  : (isMajorCategory(item.category) ? 'text-gray-300' : 'text-gray-500')
              }>
                {item.category}
              </span>
              {item.isWin && (
                <span className="text-[10px] uppercase tracking-wide text-amber-400/70 font-semibold">Won</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Resolve a precursor's nomination count. The `nominations` field is
// historically either a number (total count) or string[] (rare legacy shape).
// Returns null if the precursor doesn't track total noms (Drama League, NYDCCC).
function nomCount(nominations: unknown): number | null {
  if (typeof nominations === 'number') return nominations;
  if (Array.isArray(nominations)) return nominations.length;
  return null;
}

// Format the chip label given win + nomination counts. Lead with the more
// impressive number; only mention noms separately when there are noms BEYOND
// the wins ("3 wins / 5 noms" for a wins+extra-noms case).
function chipLabel(wins: number, nomsTotal: number): string {
  if (wins > 0) {
    const losingNoms = nomsTotal > wins ? nomsTotal - wins : 0;
    if (losingNoms > 0) {
      return `${wins} win${wins === 1 ? '' : 's'} / ${losingNoms} nom${losingNoms === 1 ? '' : 's'}`;
    }
    return `${wins} win${wins === 1 ? '' : 's'}`;
  }
  return `${nomsTotal} nom${nomsTotal === 1 ? '' : 's'}`;
}

// One precursor block inside the expanded "Other Major Awards" section.
// Renders wins first; if there are also nominee-only entries (categories
// the show was nominated for but didn't win), renders them under a
// "Nominated for" subhead. Returns null when there's nothing to show.
function PrecursorExpanded({
  label,
  wins,
  noms,
  totalNomCount,
  titleColor,
  iconColor,
  winnerNames,
}: {
  label: string;
  wins: string[];
  noms: string[];
  totalNomCount: number | null;
  titleColor: string;
  iconColor: string;
  /** Optional per-award winner names (for performer-attributed awards like
   *  Drama League Distinguished Performance). When provided, the win line
   *  renders as "Award Name — Performer Name" instead of a bare show-level
   *  win. Key = award name (must match a string in `wins`). */
  winnerNames?: Record<string, string[]>;
}) {
  const nomsOnly = noms.filter((n) => !wins.includes(n));
  if (wins.length === 0 && nomsOnly.length === 0) return null;
  const totalShown = totalNomCount && totalNomCount > wins.length ? totalNomCount : null;
  return (
    <div>
      <div className={`text-xs ${titleColor} font-medium mb-1.5`}>
        {label}
        {totalShown && (
          <span className="text-gray-500 font-normal ml-1.5">· {totalShown} total noms</span>
        )}
      </div>
      {wins.length > 0 && (
        <ul className="space-y-1 pl-4">
          {wins.map((win, idx) => {
            const performers = winnerNames?.[win] || [];
            return (
              <li key={`w-${idx}`} className="flex items-center gap-2 text-sm text-gray-400">
                <TrophyIcon className={`w-3 h-3 ${iconColor} flex-shrink-0`} />
                {win}
                {performers.length > 0 && (
                  <span className="text-gray-500 font-normal">— {performers.join(' & ')}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {nomsOnly.length > 0 && (
        <>
          <div className="text-[11px] text-gray-500 uppercase tracking-wide mt-1.5 mb-1 pl-4">
            Nominated for
          </div>
          <ul className="space-y-1 pl-4">
            {nomsOnly.map((nom, idx) => (
              <li
                key={`n-${idx}`}
                className="flex items-center gap-2 text-sm text-gray-500 italic"
              >
                <span className={`w-3 h-3 flex-shrink-0 ${iconColor} opacity-40`}>·</span>
                {nom}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Expandable section for Other Major Awards
function OtherAwardsExpandableSection({ awards }: { awards: ShowAwards }) {
  const [expanded, setExpanded] = useState(false);

  const dramaDeskWins = awards.dramadesk?.wins || [];
  const occWins = awards.outerCriticsCircle?.wins || [];
  const dramaLeagueWins = awards.dramaLeague?.wins || [];
  const nydcccWins = awards.nyDramaCritics?.wins || [];

  const dramaDeskNoms = awards.dramadesk?.nominatedFor || [];
  const occNoms = awards.outerCriticsCircle?.nominatedFor || [];
  const dramaLeagueNoms = awards.dramaLeague?.nominatedFor || [];
  const nydcccNoms = awards.nyDramaCritics?.nominatedFor || [];

  const dramaDeskNomCount = nomCount(awards.dramadesk?.nominations) ?? (dramaDeskNoms.length || null);
  const occNomCount = nomCount(awards.outerCriticsCircle?.nominations) ?? (occNoms.length || null);

  // Header total must use the SAME nom source as the per-chip label
  // (max of nominations count and nominatedFor.length) so a header that reads
  // "(5 noms)" can't disagree with chips that sum to 8.
  const dramaDeskNomTotal = dramaDeskNomCount ?? dramaDeskNoms.length;
  const occNomTotal = occNomCount ?? occNoms.length;
  const dramaLeagueNomTotal = dramaLeagueNoms.length;
  const nydcccNomTotal = nydcccNoms.length;

  const hasWinsOrNoms =
    dramaDeskWins.length + occWins.length + dramaLeagueWins.length + nydcccWins.length > 0 ||
    dramaDeskNomTotal + occNomTotal + dramaLeagueNomTotal + nydcccNomTotal > 0;

  if (!hasWinsOrNoms) return null;

  const totalWins =
    dramaDeskWins.length + occWins.length + dramaLeagueWins.length + nydcccWins.length;
  const totalNoms =
    dramaDeskNomTotal + occNomTotal + dramaLeagueNomTotal + nydcccNomTotal;
  const headerLabel =
    totalWins > 0
      ? `${totalWins} win${totalWins === 1 ? '' : 's'}`
      : `${totalNoms} nom${totalNoms === 1 ? '' : 's'}`;

  return (
    <div className="mt-4 pt-4 border-t border-white/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
            Other Major Awards
          </span>
          <span className="text-xs text-gray-500">({headerLabel})</span>
        </div>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      {/* Summary badges - always visible. "X / Y" = noms / wins when noms count
          is available; otherwise just wins. */}
      <div className="flex flex-wrap gap-2 mt-2">
        {(dramaDeskWins.length > 0 || dramaDeskNomTotal > 0) && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 text-xs font-medium border border-purple-500/20">
            {dramaDeskWins.length > 0 ? <TrophyIcon className="w-3.5 h-3.5" /> : <StarIcon className="w-3.5 h-3.5" />}
            {chipLabel(dramaDeskWins.length, dramaDeskNomTotal)} Drama Desk
          </span>
        )}
        {(occWins.length > 0 || occNomTotal > 0) && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 text-xs font-medium border border-cyan-500/20">
            {occWins.length > 0 ? <TrophyIcon className="w-3.5 h-3.5" /> : <StarIcon className="w-3.5 h-3.5" />}
            {chipLabel(occWins.length, occNomTotal)} Outer Critics
          </span>
        )}
        {(dramaLeagueWins.length > 0 || dramaLeagueNomTotal > 0) && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-teal-500/10 text-teal-400 text-xs font-medium border border-teal-500/20">
            {dramaLeagueWins.length > 0 ? <TrophyIcon className="w-3.5 h-3.5" /> : <StarIcon className="w-3.5 h-3.5" />}
            {chipLabel(dramaLeagueWins.length, dramaLeagueNomTotal)} Drama League
          </span>
        )}
        {(nydcccWins.length > 0 || nydcccNomTotal > 0) && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/10 text-rose-400 text-xs font-medium border border-rose-500/20">
            {nydcccWins.length > 0 ? <TrophyIcon className="w-3.5 h-3.5" /> : <StarIcon className="w-3.5 h-3.5" />}
            {chipLabel(nydcccWins.length, nydcccNomTotal)} NY Drama Critics
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 space-y-3">
          <PrecursorExpanded
            label="Drama Desk Awards"
            wins={dramaDeskWins}
            noms={dramaDeskNoms}
            totalNomCount={dramaDeskNomCount}
            titleColor="text-purple-400"
            iconColor="text-purple-400"
          />
          <PrecursorExpanded
            label="Outer Critics Circle Awards"
            wins={occWins}
            noms={occNoms}
            totalNomCount={occNomCount}
            titleColor="text-cyan-400"
            iconColor="text-cyan-400"
          />
          <PrecursorExpanded
            label="Drama League Awards"
            wins={dramaLeagueWins}
            noms={dramaLeagueNoms}
            totalNomCount={null}
            titleColor="text-teal-400"
            iconColor="text-teal-400"
            winnerNames={awards.dramaLeague?.winnerNames}
          />
          <PrecursorExpanded
            label={"NY Drama Critics’ Circle Awards"}
            wins={nydcccWins}
            noms={nydcccNoms}
            totalNomCount={null}
            titleColor="text-rose-400"
            iconColor="text-rose-400"
          />
        </div>
      )}
    </div>
  );
}

export default function AwardsCard({ showId, awards, openingDate, tonyNamesByCategory }: AwardsCardProps) {
  // Guard here (not in server page.tsx) so isDemo() is evaluated at runtime.
  if (!featureFlags.awards) return null;

  // v2 card behind feature flag — same props, completely different rendering.
  // See src/components/AwardScoreCard.tsx and src/lib/awards-scoring.ts.
  if (featureFlags.awardScoreV2) {
    return <AwardScoreCard showId={showId} awards={awards} openingDate={openingDate} tonyNamesByCategory={tonyNamesByCategory} />;
  }

  const designation = getAwardsDesignation(showId, openingDate);
  const tonyWins = getTonyWinCount(showId);
  const tonyNoms = getTonyNominationCount(showId);
  const isPulitzerWinner = !!awards?.pulitzer?.wins?.includes('Drama');
  const isPulitzerFinalist = !!awards?.pulitzer?.finalist?.includes('Drama');
  const hasPulitzer = isPulitzerWinner || isPulitzerFinalist;
  const config = DESIGNATION_CONFIG[designation];

  // Get wins and nominations lists
  const tonyWinsList = awards?.tony?.wins || [];
  const tonyNominatedFor = awards?.tony?.nominatedFor || [];
  // Nominations that aren't wins
  const tonyNominationsOnly = tonyNominatedFor.filter(nom => !tonyWinsList.includes(nom));

  // Don't show card if pre-season with no data
  if (designation === 'pre-season' && !awards?.tony?.note) {
    // Check if the show is genuinely pre-season or just missing data
    // Tony ceremonies are in June; shows opening 14+ months ago have been through at least one season
    const isPastEligibility = openingDate && (
      new Date().getTime() - new Date(openingDate).getTime() > 14 * 30 * 24 * 60 * 60 * 1000
    );

    if (isPastEligibility) {
      // Historical show without awards data — hide the card entirely
      return null;
    }

    return (
      <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-4 sm:mb-6">
        <h2 className="text-lg font-bold text-white mb-3">Awards Scorecard</h2>
        <p className="text-gray-400 text-sm">This show has not yet been eligible for major awards.</p>
      </section>
    );
  }

  // Get Tony season for display
  const tonySeason = awards?.tony?.season;
  const tonyCeremony = awards?.tony?.ceremony;

  // Build sublabel based on actual data
  let dynamicSublabel = config.sublabel;
  if (designation === 'sweeper' && tonyWinsList.length > 0) {
    const topWin = sortByImportance(tonyWinsList)[0];
    dynamicSublabel = `Won ${topWin} + ${tonyWins - 1} more`;
  } else if (designation === 'lavished' && tonyWinsList.length > 0) {
    dynamicSublabel = `${tonyWins} Tony wins`;
  } else if (designation === 'recognized' && tonyWinsList.length > 0) {
    const topWin = sortByImportance(tonyWinsList)[0];
    dynamicSublabel = `Won ${topWin}`;
  } else if (designation === 'nominated' && tonyNoms > 0) {
    dynamicSublabel = `${tonyNoms} Tony nomination${tonyNoms > 1 ? 's' : ''}`;
  }

  // Build a "year season meta" string for the right-aligned header slot.
  // E.g. "2025–26 season" when we have a Tony season; falls back to year.
  const awardsMeta = tonySeason
    ? `${tonySeason} season`
    : (awards?.tony?.ceremony ?? null);

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby="awards-scorecard-heading">
      {/* Unified scorecard chrome: eyebrow + lowercase season meta */}
      <header className="flex items-center justify-between gap-3 mb-4">
        <h2 id="awards-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Awards Scorecard</h2>
        {awardsMeta && (
          <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
            {awardsMeta}
          </span>
        )}
      </header>

      {/* Main Designation Badge - More prominent (colors preserved per
          parallel session's recent shipped polish) */}
      <div className={`rounded-xl p-4 border mb-4 ${config.bgClass} ${config.borderClass}`}>
        <div className="flex items-center gap-3">
          {tonyWins > 0 && <TrophyIcon className={`${config.textClass} w-6 h-6`} />}
          {tonyWins === 0 && tonyNoms > 0 && <StarIcon className={`${config.textClass} w-5 h-5`} />}
          {tonyWins === 0 && tonyNoms === 0 && (
            <div className={`w-5 h-5 rounded-full border-2 ${config.borderClass}`} />
          )}
          <div>
            <div className={`text-lg font-bold ${config.textClass}`}>{config.label}</div>
            <div className="text-sm text-gray-400">{dynamicSublabel}</div>
          </div>
        </div>
        {/* Render tony.note when present — most important for 'ineligible' shows
            (explains the Committee's ruling) and 'pre-season' shows that have
            opening-date context (e.g. "Not yet eligible — opens Nov 2025"). */}
        {awards?.tony?.note && (
          <p className="text-sm text-gray-300 mt-3">{awards.tony.note}</p>
        )}
      </div>

      {/* Pulitzer Special Callout — Winner gets full amber callout; Finalist
          gets a quieter "Finalist" treatment. Year suffix omitted if absent. */}
      {hasPulitzer && awards?.pulitzer && (
        <div
          className={
            isPulitzerWinner
              ? 'bg-gradient-to-r from-amber-500/10 to-yellow-500/10 rounded-lg p-3 border border-amber-500/20 mb-4'
              : 'bg-amber-500/5 rounded-lg p-3 border border-amber-500/15 mb-4'
          }
        >
          <div className="flex items-center gap-2">
            <PulitzerIcon className={isPulitzerWinner ? 'text-amber-400' : 'text-amber-400/70'} />
            <span
              className={isPulitzerWinner ? 'text-amber-300 font-medium' : 'text-amber-200/80'}
            >
              Pulitzer Prize for Drama
              {isPulitzerWinner ? ' Winner' : ' Finalist'}
              {typeof awards.pulitzer.year === 'number' ? ` (${awards.pulitzer.year})` : ''}
            </span>
          </div>
        </div>
      )}

      {/* Tony Stats Summary */}
      {(tonyWins > 0 || tonyNoms > 0) && (
        <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
              Tony Awards {tonySeason && `(${tonySeason})`}
            </span>
            {tonyCeremony && (
              <span className="text-xs text-gray-500">{tonyCeremony} Ceremony</span>
            )}
          </div>

          {/* Win/Nom counts */}
          <div className="flex flex-wrap gap-4">
            {tonyWins > 0 && (
              <div className="flex items-center gap-1.5">
                <TrophyIcon className="text-amber-400" />
                <span className="text-white font-bold text-lg">{tonyWins}</span>
                <span className="text-gray-400 text-sm">Win{tonyWins !== 1 ? 's' : ''}</span>
              </div>
            )}
            {tonyNominationsOnly.length > 0 && (
              <div className="flex items-center gap-1.5">
                <StarIcon className="text-gray-400" />
                <span className="text-white font-bold text-lg">{tonyNominationsOnly.length}</span>
                <span className="text-gray-400 text-sm">{tonyWins > 0 ? 'Other ' : ''}Nomination{tonyNominationsOnly.length !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>

          {/* Combined expandable section for all Tony categories */}
          <TonyExpandableSection
            wins={tonyWinsList}
            nominations={tonyNominationsOnly}
            defaultExpanded={tonyWinsList.length + tonyNominationsOnly.length <= 5}
          />

          {/* Cross-link to predictions */}
          {featureFlags.tonyPredictions && tonySeason && (
            <div className="border-t border-white/5 pt-3 mt-3">
              <Link
                href={`/tony-awards/predictions/${toFullSeasonLabel(tonySeason)}`}
                className="text-sm text-brand hover:text-brand-hover transition-colors"
              >
                See {tonySeason} predictions &rarr;
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Other Major Awards - Expandable */}
      {awards && <OtherAwardsExpandableSection awards={awards} />}

      {/* Footer: two links — dedicated AwardScore leaderboard (new
          /award-score route shipped by parallel session 2026-05-17) and
          season-specific Tony predictions page. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Link
          href={awards?.tony?.season ? `/award-score/${seasonSlug(awards.tony.season)}` : '/award-score'}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
        >
          <span>See all award scores</span>
          <span className="inline-block transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </Link>
        <Link
          href={awards?.tony?.season ? `/tony-awards/predictions/${toFullSeasonLabel(awards.tony.season)}` : '/tony-awards/predictions'}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
        >
          <span>See Tony predictions</span>
          <span className="inline-block transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
