'use client';

import { useState } from 'react';
import Link from 'next/link';
import { computeSiteAwardScore, type CeremonyContribution } from '@/lib/awards-scoring';
import type { ShowAwards } from '@/lib/data-types';
import { ChevronIcon, PulitzerIcon, TrophyIconLine, StarIconLine } from '@/components/icons';
import { sortByImportance, isMajorCategory } from '@/config/awards';
import { AwardScoreBadge, AWARD_TIER_LABEL, getAwardTierLabelClass } from '@/components/show-cards';
import { featureFlags } from '@/config/feature-flags';
import { daysUntilTonyCeremony } from '@/lib/tony-cutoffs';

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

function CountdownPill({ season }: { season: string }) {
  // Days-to-ceremony pill — gives concrete urgency instead of generic
  // "Provisional." When the ceremony date isn't in our records, falls back
  // to generic Provisional so the in-progress signal is never lost.
  const days = daysUntilTonyCeremony(season);
  const label = days === null
    ? 'Provisional'
    : days === 1
      ? '1 day to Tony ceremony'
      : `${days} days to Tony ceremony`;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      {label}
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

      {/* Single-line "X wins of Y noms" — no mental math required, leads
          with the more impressive number (wins). Per Claude Design 2026-05-17. */}
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 text-sm">
        <div className="flex items-baseline gap-1.5">
          <TrophyIconLine className="text-amber-400 self-center" />
          <span className="text-white font-bold text-lg tabular-nums leading-none">{wins.length}</span>
          <span className="text-gray-400">win{wins.length === 1 ? '' : 's'}</span>
        </div>
        {(wins.length + nominationsOnly.length) > 0 && (
          <span className="text-gray-500">of</span>
        )}
        {(wins.length + nominationsOnly.length) > 0 && (
          <div className="flex items-baseline gap-1.5">
            <StarIconLine className="text-gray-400 self-center" />
            <span className="text-white font-bold text-lg tabular-nums leading-none">{wins.length + nominationsOnly.length}</span>
            <span className="text-gray-400">nom{(wins.length + nominationsOnly.length) === 1 ? '' : 's'}</span>
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
                    <TrophyIconLine className="text-amber-400 flex-shrink-0" />
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
                    <StarIconLine className="text-gray-500 flex-shrink-0" />
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
}

// Per-ceremony color coding (re-introduced per Claude Design 2026-05-17 after
// being briefly neutralized). Colors give each ceremony its own glanceable
// identity in the chip row — important when 4 chips sit side-by-side.
const OTHER_CONFIGS: OtherAwardConfig[] = [
  { key: 'dramaDesk',   short: 'Drama Desk',       display: 'Drama Desk Awards',                ceremonyName: 'Drama Desk',                  chip: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-300' },
  { key: 'occ',         short: 'Outer Critics',    display: 'Outer Critics Circle',             ceremonyName: 'Outer Critics Circle',        chip: 'bg-cyan-500/10 border-cyan-500/20',     text: 'text-cyan-300' },
  { key: 'dramaLeague', short: 'Drama League',     display: 'Drama League Awards',              ceremonyName: 'Drama League',                chip: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-300' },
  { key: 'nydcc',       short: 'NY Drama Critics', display: "NY Drama Critics' Circle Awards",  ceremonyName: "NY Drama Critics' Circle",    chip: 'bg-rose-500/10 border-rose-500/20',     text: 'text-rose-300' },
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
    const nominationsCount = typeof rawNoms === 'number' ? rawNoms
      : Array.isArray(rawNoms) ? rawNoms.length
      : null;
    const nominatedFor = node && 'nominatedFor' in node && Array.isArray(node.nominatedFor)
      ? node.nominatedFor : [];
    // Prefer the larger source of nomination count. DD/OCC publish a `nominations`
    // total separate from the per-category `nominatedFor` list (which may be
    // incomplete for older shows). DL/NYDCCC only have `nominatedFor`.
    const nomsTotal = Math.max(nominationsCount ?? 0, nominatedFor.length) || null;
    const contrib = byName.get(cfg.ceremonyName);
    return { cfg, wins, nominatedFor, nomsTotal, contrib };
  })
    // Render a row only when we can produce a real label: either wins exist,
    // or some flavor of nom count > 0. Subtotal-only (uncategorized) rows are
    // suppressed to avoid "0 noms" chips — their points still affect the
    // overall Award Score badge upstream.
    .filter(r => r.wins.length > 0 || (r.nomsTotal ?? 0) > 0)
    // Sort by wins desc, then noms desc, so the most impressive ceremony leads.
    .sort((a, b) => (b.wins.length - a.wins.length) || ((b.nomsTotal ?? 0) - (a.nomsTotal ?? 0)));

  if (rows.length === 0) return null;

  const totalWins = rows.reduce((s, r) => s + r.wins.length, 0);
  const totalNoms = rows.reduce((s, r) => s + (r.nomsTotal ?? 0), 0);
  const headerCount = totalWins > 0
    ? `${totalWins} win${totalWins === 1 ? '' : 's'}`
    : `${totalNoms} nom${totalNoms === 1 ? '' : 's'}`;

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
          <span className="text-xs text-gray-500">({headerCount})</span>
        </div>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      {/* Chip format per Claude Design 2026-05-17:
            "Drama Desk: 1 win / 5 noms"
          Color-coded per ceremony so the row is glanceable; ceremony name
          leads (the noun the user recognizes), counts trail. */}
      <div className="flex flex-wrap gap-2 mt-2">
        {rows.map(({ cfg, wins, nomsTotal }) => {
          const winsLabel = `${wins.length} win${wins.length === 1 ? '' : 's'}`;
          const nomsLabel = nomsTotal && nomsTotal > wins.length
            ? ` / ${nomsTotal} nom${nomsTotal === 1 ? '' : 's'}`
            : '';
          const detail = wins.length === 0 && nomsTotal
            ? `${nomsTotal} nom${nomsTotal === 1 ? '' : 's'}`
            : `${winsLabel}${nomsLabel}`;
          return (
            <span key={cfg.key} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${cfg.chip} text-xs font-medium`}>
              <span className={cfg.text}>{cfg.short}:</span>
              <span className="text-gray-300 tabular-nums">{detail}</span>
            </span>
          );
        })}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {rows.map(({ cfg, wins, nominatedFor, nomsTotal, contrib }) => {
            const pointMap = pointsByCategory(contrib?.items);
            const nomsOnly = nominatedFor.filter(n => !wins.includes(n));
            return (
              <div key={cfg.key}>
                <div className={`text-xs font-medium mb-1.5 ${cfg.text}`}>
                  {cfg.display}
                  {nomsTotal && nomsTotal > wins.length && (
                    <span className="text-gray-500 font-normal ml-1.5">· {nomsTotal} total noms</span>
                  )}
                </div>
                {wins.length > 0 && (
                  <ul className="space-y-1 pl-4">
                    {wins.map((win, idx) => {
                      const pts = Math.round(pointMap.get(`win:${win}`) ?? 0);
                      return (
                        <li key={`w-${idx}`} className="flex items-center gap-2 text-sm text-gray-400">
                          <TrophyIconLine className="w-3 h-3 text-amber-400 flex-shrink-0" />
                          <span className="flex-1">{win}</span>
                          {pts > 0 && <span className="text-xs text-gray-500 tabular-nums">+{pts}</span>}
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
                      {nomsOnly.map((nom, idx) => {
                        const pts = Math.round(pointMap.get(`nom:${nom}`) ?? 0);
                        return (
                          <li
                            key={`n-${idx}`}
                            className="flex items-center gap-2 text-sm text-gray-500 italic"
                          >
                            <StarIconLine className="w-3 h-3 text-gray-500/60 flex-shrink-0" />
                            <span className="flex-1">{nom}</span>
                            {pts > 0 && <span className="text-xs text-gray-500 tabular-nums not-italic">+{pts}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
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

  const seasonForCountdown = result.inProgress && awards?.tony?.season ? awards.tony.season : null;

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Awards Scorecard</h2>
        {awards?.tony?.season && (
          <span className="text-xs text-gray-500 uppercase tracking-wide whitespace-nowrap">{awards.tony.season} season</span>
        )}
      </div>

      <div className="flex items-center gap-4 mb-4">
        <AwardScoreBadge score={result.displayScore} badge={result.badge} inProgress={result.inProgress} size="lg" />
        <div className="min-w-0 flex-1">
          {/* Tier label upgraded per Claude Design 2026-05-17:
                uppercase + larger size + tier-color, so it reads as a status
                headline (parallel to "Critical Gold" / "Loving It" on critic
                and audience cards). */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xl sm:text-2xl font-bold uppercase tracking-tight ${getAwardTierLabelClass(result.badge, result.displayScore)}`}>{tierLabel}</span>
          </div>
          {sublabel && <div className="text-sm text-gray-400 line-clamp-2 mt-0.5">{sublabel}</div>}
          {seasonForCountdown && result.displayScore > 0 && (
            <div className="mt-2">
              <CountdownPill season={seasonForCountdown} />
            </div>
          )}
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

      {(() => {
        // Show breakdown fallback when the standard panels (Tony, OtherAwards) have nothing
        // to display. OtherAwardsPanel covers Drama Desk/OCC/DramaLeague/NYDCC from shows.json —
        // it silently renders nothing for Olivier/Obie/Lortel/etc. (OB/WE-specific ceremonies).
        const hasStandardContent = awards?.tony || awards?.dramadesk || awards?.outerCriticsCircle
          || awards?.dramaLeague || awards?.nyDramaCritics;
        if (hasStandardContent || result.breakdown.length === 0) return null;
        return (
          <div className="mt-4 pt-4 border-t border-white/5">
            <div className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-3">Award Recognition</div>
            <div className="space-y-3">
              {result.breakdown.map(contrib => (
                <div key={contrib.ceremony}>
                  <div className="text-xs text-gray-500 font-medium mb-1">{contrib.ceremony}</div>
                  <ul className="space-y-1">
                    {contrib.items.map((item, idx) => (
                      <li key={idx} className="flex items-center gap-2 text-sm">
                        {item.result === 'win'
                          ? <span className="text-amber-400 text-xs">★</span>
                          : <span className="text-gray-500 text-xs">☆</span>
                        }
                        <span className={item.result === 'win' ? 'text-gray-200' : 'text-gray-400 italic'}>
                          {item.category}
                        </span>
                        <span className={`ml-auto text-xs ${item.result === 'win' ? 'text-amber-400' : 'text-gray-500'}`}>
                          {item.result === 'win' ? 'Won' : 'Nominated'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

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
