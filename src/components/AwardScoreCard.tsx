'use client';

import { useState } from 'react';
import Link from 'next/link';
import { computeSiteAwardScore, type CeremonyContribution } from '@/lib/awards-scoring';
import type { ShowAwards } from '@/lib/data-types';
import { TrophyIcon, StarIcon, ChevronIcon, PulitzerIcon } from '@/components/icons';
import { sortByImportance, isMajorCategory } from '@/config/awards';
import { AwardScoreBadge, AWARD_TIER_LABEL, getAwardTierLabelClass } from '@/components/show-cards';
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

// "Best Direction of a Musical" → "Best Direction (Musical)" so mobile lines
// don't wrap awkwardly inside the expandable list.
function shortCategory(c: string): string {
  return c
    .replace(/ in a Musical$/, ' (Musical)')
    .replace(/ in a Play$/, ' (Play)')
    .replace(/ of a Musical$/, ' (Musical)')
    .replace(/ of a Play$/, ' (Play)');
}

// Sublabel sits right above the Tony stats panel, which already shows
// "X Wins · Y Nominations." So the sublabel must add *new* signal — the
// marquee win or top nomination — never repeat the counts.
function buildSublabel(awards: ShowAwards | undefined, badge: string, inProgress: boolean): string {
  const tonyWins = sortByImportance(awards?.tony?.wins ?? []);
  const tonyNoms = sortByImportance(awards?.tony?.nominatedFor ?? []);
  if (tonyWins.length > 0) {
    const top = shortCategory(tonyWins[0]);
    return tonyWins.length > 1 ? `Won ${top} + ${tonyWins.length - 1} more` : `Won ${top}`;
  }
  if (inProgress && tonyNoms.length > 0) {
    return `Nominated for ${shortCategory(tonyNoms[0])}`;
  }
  if (inProgress) return 'Awards season in progress';
  if (tonyNoms.length > 0) return `Nominated for ${shortCategory(tonyNoms[0])}`;
  if (badge === 'eligible') return 'Eligible for awards';
  return '';
}

function pointsByCategory(items: CeremonyContribution['items'] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!items) return m;
  for (const it of items) {
    const key = `${it.result}:${it.category}`;
    m.set(key, (m.get(key) ?? 0) + it.points);
  }
  return m;
}

function ProvisionalPill() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      Provisional
    </span>
  );
}

// Tony Awards panel — always visible (stats + expandable categories with
// per-category point values). Mirrors the older AwardsCard structure (legacy
// fallback when awardScoreV2 flag is off), with point values overlaid.
function TonyAwardsPanel({
  tony,
  contrib,
  inProgress,
}: {
  tony: NonNullable<ShowAwards['tony']>;
  contrib: CeremonyContribution | undefined;
  inProgress: boolean;
}) {
  const wins = tony.wins ?? [];
  const nominatedFor = tony.nominatedFor ?? [];
  const nominationsOnly = nominatedFor.filter(n => !wins.includes(n));
  const totalCount = wins.length + nominationsOnly.length;
  const [expanded, setExpanded] = useState(totalCount > 0 && totalCount <= 5);
  const pointMap = pointsByCategory(contrib?.items);
  const sortedWins = sortByImportance(wins);
  const sortedNoms = sortByImportance(nominationsOnly);

  return (
    <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
      <div className="mb-3">
        <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
          Tony Awards {tony.season && `(${tony.season})`}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {wins.length > 0 && (
          <div className="flex items-center gap-1.5">
            <TrophyIcon className="text-amber-400" />
            <span className="text-white font-bold text-lg tabular-nums">{wins.length}</span>
            <span className="text-gray-400 text-sm">Win{wins.length !== 1 ? 's' : ''}</span>
          </div>
        )}
        {nominationsOnly.length > 0 && (
          <div className="flex items-center gap-1.5">
            <StarIcon className="text-gray-400" />
            <span className="text-white font-bold text-lg tabular-nums">{nominationsOnly.length}</span>
            <span className="text-gray-400 text-sm">{wins.length > 0 ? 'Other ' : ''}Nomination{nominationsOnly.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {totalCount > 0 && (
        <div className="border-t border-white/5 pt-3 mt-3">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between text-left group"
            aria-expanded={expanded}
          >
            <span className="text-sm font-medium text-gray-300">
              See all categories ({totalCount})
            </span>
            <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
          </button>
          {expanded && (
            <ul className="mt-3 space-y-2">
              {sortedWins.map((cat, idx) => {
                const pts = Math.round(pointMap.get(`win:${cat}`) ?? 0);
                const major = isMajorCategory(cat);
                return (
                  <li key={`w-${idx}`} className="flex items-center gap-2 text-sm">
                    <TrophyIcon className="text-amber-400 flex-shrink-0" />
                    <span className={`flex-1 ${major ? 'text-white font-medium' : 'text-amber-200'}`}>
                      {cat}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-amber-400/70 font-semibold">Won</span>
                    {pts > 0 && (
                      <span className="text-xs text-gray-500 tabular-nums w-10 text-right">+{pts}</span>
                    )}
                  </li>
                );
              })}
              {sortedNoms.map((cat, idx) => {
                const pts = Math.round(pointMap.get(`nom:${cat}`) ?? 0);
                const major = isMajorCategory(cat);
                return (
                  <li key={`n-${idx}`} className="flex items-center gap-2 text-sm">
                    <StarIcon className="text-gray-500 flex-shrink-0" />
                    <span className={`flex-1 ${major ? 'text-gray-300' : 'text-gray-500'}`}>
                      {cat}
                    </span>
                    {pts > 0 && (
                      <span className="text-xs text-gray-500 tabular-nums w-10 text-right">+{pts}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Predictions cross-link — only while the season is in progress. After
          the ceremony, predictions read as a retrospective and pull users off
          the show page for less value. */}
      {featureFlags.tonyPredictions && tony.season && inProgress && (
        <div className="border-t border-white/5 pt-3 mt-3">
          <Link
            href={`/tony-awards/predictions/${toFullSeasonLabel(tony.season)}`}
            className="text-sm text-brand hover:text-brand-hover transition-colors"
          >
            See {tony.season} Tony predictions &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}

interface OtherAwardConfig {
  key: 'dramaDesk' | 'occ' | 'dramaLeague' | 'nydcc';
  short: string;
  display: string;
  ceremonyName: string;
  chip: string;
  text: string;
  iconColor: string;
}

const OTHER_CONFIGS: OtherAwardConfig[] = [
  { key: 'dramaDesk',   short: 'Drama Desk',       display: 'Drama Desk Awards',                ceremonyName: 'Drama Desk',                  chip: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-400', iconColor: 'text-purple-400' },
  { key: 'occ',         short: 'Outer Critics',    display: 'Outer Critics Circle',             ceremonyName: 'Outer Critics Circle',        chip: 'bg-cyan-500/10 border-cyan-500/20',     text: 'text-cyan-400',   iconColor: 'text-cyan-400' },
  { key: 'dramaLeague', short: 'Drama League',     display: 'Drama League Awards',              ceremonyName: 'Drama League',                chip: 'bg-teal-500/10 border-teal-500/20',     text: 'text-teal-400',   iconColor: 'text-teal-400' },
  { key: 'nydcc',       short: 'NY Drama Critics', display: "NY Drama Critics' Circle Awards",  ceremonyName: "NY Drama Critics' Circle",    chip: 'bg-rose-500/10 border-rose-500/20',     text: 'text-rose-400',   iconColor: 'text-rose-400' },
];

function nodeFor(awards: ShowAwards, key: OtherAwardConfig['key']) {
  if (key === 'dramaDesk') return awards.dramadesk;
  if (key === 'occ') return awards.outerCriticsCircle;
  if (key === 'dramaLeague') return awards.dramaLeague;
  if (key === 'nydcc') return awards.nyDramaCritics;
  return undefined;
}

function OtherAwardsPanel({
  awards,
  breakdown,
}: {
  awards: ShowAwards;
  breakdown: CeremonyContribution[];
}) {
  const [expanded, setExpanded] = useState(false);
  const byName = new Map(breakdown.map(c => [c.ceremony, c]));

  const rows = OTHER_CONFIGS.map(cfg => {
    const node = nodeFor(awards, cfg.key);
    const wins = node?.wins ?? [];
    const rawNoms = node && 'nominations' in node ? node.nominations : undefined;
    const nomsTotal = typeof rawNoms === 'number' ? rawNoms
      : Array.isArray(rawNoms) ? rawNoms.length
      : null;
    const contrib = byName.get(cfg.ceremonyName);
    return { cfg, wins, nomsTotal, contrib };
  }).filter(r => r.wins.length > 0 || (r.contrib?.subtotal ?? 0) > 0);

  if (rows.length === 0) return null;

  const totalWins = rows.reduce((s, r) => s + r.wins.length, 0);

  return (
    <div className="mt-4 pt-4 border-t border-white/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Other Major Awards</span>
          <span className="text-xs text-gray-500">({totalWins} win{totalWins === 1 ? '' : 's'})</span>
        </div>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      <div className="flex flex-wrap gap-2 mt-2">
        {rows.map(({ cfg, wins, nomsTotal }) => {
          const winLabel = nomsTotal && nomsTotal > wins.length
            ? `${nomsTotal} noms / ${wins.length} wins`
            : `${wins.length} win${wins.length === 1 ? '' : 's'}`;
          return (
            <span key={cfg.key} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${cfg.chip} ${cfg.text} text-xs font-medium`}>
              <TrophyIcon className="w-3.5 h-3.5" />
              <span>{winLabel} {cfg.short}</span>
            </span>
          );
        })}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {rows.map(({ cfg, wins, nomsTotal, contrib }) => {
            const pointMap = pointsByCategory(contrib?.items);
            return (
              <div key={cfg.key}>
                <div className={`text-xs font-medium mb-1.5 ${cfg.text}`}>
                  {cfg.display}
                  {nomsTotal && nomsTotal > wins.length && (
                    <span className="text-gray-500 font-normal ml-1.5">· {nomsTotal} total noms</span>
                  )}
                </div>
                <ul className="space-y-1 pl-4">
                  {wins.map((win, idx) => {
                    const pts = Math.round(pointMap.get(`win:${win}`) ?? 0);
                    return (
                      <li key={idx} className="flex items-center gap-2 text-sm text-gray-400">
                        <TrophyIcon className={`w-3 h-3 ${cfg.iconColor} flex-shrink-0`} />
                        <span className="flex-1">{win}</span>
                        {pts > 0 && <span className="text-xs text-gray-500 tabular-nums">+{pts}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AwardScoreCard({ showId, awards, openingDate }: AwardScoreCardProps) {
  const result = computeSiteAwardScore(showId, 'broadway');

  if (result.displayScore === 0 && !result.inProgress) {
    const openingMs = openingDate ? new Date(openingDate).getTime() : 0;
    const monthsSinceOpening = openingMs ? (Date.now() - openingMs) / (30 * 24 * 60 * 60 * 1000) : Infinity;
    if (monthsSinceOpening > 14) return null;
  }

  const isPulitzerWinner = !!awards?.pulitzer?.wins?.includes('Drama');
  const isPulitzerFinalist = !!awards?.pulitzer?.finalist?.includes('Drama') || !!awards?.pulitzerFinalist;
  const hasPulitzer = isPulitzerWinner || isPulitzerFinalist;
  const pulitzerYear = awards?.pulitzer?.year ?? awards?.pulitzerFinalist?.year;
  const tierLabel = result.inProgress && result.badge === 'nominated' ? 'In the Hunt' : AWARD_TIER_LABEL[result.badge];
  const sublabel = buildSublabel(awards, result.badge, result.inProgress);

  const tonyContrib = result.breakdown.find(c => c.ceremony === 'Tony Awards');
  const hasTony = !!awards?.tony && ((awards.tony.wins?.length ?? 0) > 0 || (awards.tony.nominatedFor?.length ?? 0) > 0);

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards Scorecard</h2>

      <div className="flex items-center gap-4 mb-4">
        <AwardScoreBadge score={result.displayScore} badge={result.badge} inProgress={result.inProgress} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-lg font-bold ${getAwardTierLabelClass(result.badge, result.displayScore)}`}>{tierLabel}</span>
            {result.inProgress && result.displayScore > 0 && <ProvisionalPill />}
          </div>
          {sublabel && <div className="text-sm text-gray-400 line-clamp-2">{sublabel}</div>}
        </div>
      </div>

      {hasPulitzer && (
        <div className="flex items-center gap-2 text-sm mb-4">
          <PulitzerIcon className={`flex-shrink-0 ${isPulitzerWinner ? 'text-amber-400' : 'text-amber-400/70'}`} />
          <span className={`flex-1 ${isPulitzerWinner ? 'text-amber-300 font-medium' : 'text-amber-200/80'}`}>
            Pulitzer Prize for Drama{isPulitzerWinner ? ' Winner' : ' Finalist'}
            {typeof pulitzerYear === 'number' ? ` (${pulitzerYear})` : ''}
          </span>
        </div>
      )}

      {hasTony && awards?.tony && (
        <TonyAwardsPanel tony={awards.tony} contrib={tonyContrib} inProgress={result.inProgress} />
      )}

      {awards && <OtherAwardsPanel awards={awards} breakdown={result.breakdown} />}

      {result.displayScore === 0 && result.inProgress && !hasTony && (
        <p className="text-sm text-gray-400">
          No awards recognition yet this season. First nominations land in late April.
        </p>
      )}

      {(hasTony || hasPulitzer || result.displayScore > 0) && (
        <div className="mt-4 pt-3 border-t border-white/5">
          <Link
            href="/methodology#award-score"
            className="text-xs text-gray-500 hover:text-brand transition-colors inline-flex items-center gap-1"
          >
            How the Award Score works
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      )}
    </div>
  );
}
