'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ScoreBadge, getScoreTier } from '@/components/show-cards';
import { AwardScoreBadge } from '@/components/show-cards/AwardScoreBadge';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { getOutletLogoUrl, getOutletConfig } from '@/config/outlet-logos';
import type { TierBadge } from '@/lib/awards-scoring';
import type { SerializedTonyShow } from '@/lib/data-tony-predictions';

// Maps outlet IDs in tony-critic-picks.json → outlet names in OUTLET_LOGOS registry
const CRITIC_PICK_OUTLETS: Record<string, { outletName: string; critic: string }> = {
  nyt:     { outletName: 'The New York Times', critic: 'Helen Shaw' },
  variety: { outletName: 'Variety',            critic: 'Clayton Davis' },
  deadline:{ outletName: 'Deadline',           critic: 'Greg Evans' },
};

export type PredictionMode = 'combined' | 'critics' | 'audience';
export type { SerializedTonyShow };

/** Softmax win probabilities, T=7 (closer to market odds than T=10). */
function computeWinProbabilities(shows: SerializedTonyShow[], mode: PredictionMode): Map<string, number> {
  const T = 7;
  const scored = shows.filter(s => getScoreForMode(s, mode) != null);
  if (scored.length === 0) return new Map();
  const exps = scored.map(s => Math.exp((getScoreForMode(s, mode) as number) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  const result = new Map<string, number>();
  scored.forEach((show, i) => result.set(show.slug, exps[i] / sum));
  return result;
}

export interface CategoryOutcome {
  status: 'correct' | 'missed';
  winnerTitle: string;
  winnerRank: number | null;
  predictedTitle: string | null;
}

interface TonyPredictionsTableProps {
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
  sectionId?: string;
  startIndex?: number;
  outcomes?: Record<string, 'winner' | 'nominated'>;
  categoryOutcome?: CategoryOutcome;
  ineligible?: Array<{ slug: string; title: string; note: string }>;
  mode?: PredictionMode;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getEffectiveStatus(show: SerializedTonyShow): string {
  if (show.status !== 'previews') return show.status;
  const today = new Date().toISOString().slice(0, 10);
  const previewsStart = show.previewsStartDate || show.openingDate;
  if (previewsStart > today) return 'announced';
  return 'previews';
}

function OutletPickLogo({ outletId }: { outletId: string }) {
  const [imgError, setImgError] = useState(false);
  const meta = CRITIC_PICK_OUTLETS[outletId];
  if (!meta) return null;
  const logoUrl = getOutletLogoUrl(meta.outletName);
  const config = getOutletConfig(meta.outletName);
  const title = `${meta.outletName} (${meta.critic}) picks this show to win`;

  if (logoUrl && !imgError) {
    return (
      <div className="w-5 h-5 rounded-full bg-white flex items-center justify-center flex-shrink-0 overflow-hidden" title={title}>
        <img
          src={logoUrl}
          alt={meta.outletName}
          className="w-3.5 h-3.5 object-contain"
          onError={() => setImgError(true)}
        />
      </div>
    );
  }
  const abbrev = config?.abbrev || meta.outletName.charAt(0);
  const bgColor = config?.color || '#374151';
  const textSize = abbrev.length > 2 ? 'text-[7px]' : 'text-[9px]';
  return (
    <div
      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${textSize} font-bold text-white leading-none`}
      style={{ backgroundColor: bgColor }}
      title={title}
    >
      {abbrev}
    </div>
  );
}

const PRECURSOR_LABELS: Record<string, string> = {
  DL: 'Drama League',
  OCC: 'Outer Critics Circle',
  DD: 'Drama Desk',
  PULITZER: 'Pulitzer Prize for Drama',
  NYDCC: 'NY Drama Critics Circle',
};

function PrecursorChips({ wins }: { wins?: string[] }) {
  if (!wins || wins.length === 0) return <span className="text-xs text-gray-600">—</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      {wins.map(w => (
        <span
          key={w}
          title={`Won ${PRECURSOR_LABELS[w] ?? w} in this category`}
          className="text-[10px] font-semibold text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-1 py-0.5 leading-none"
        >
          {w}
        </span>
      ))}
    </div>
  );
}

function PressPicks({ picks }: { picks?: string[] }) {
  if (!picks || picks.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {picks.map(id => <OutletPickLogo key={id} outletId={id} />)}
    </div>
  );
}


function getScoreForMode(show: SerializedTonyShow, mode: PredictionMode): number | null {
  switch (mode) {
    case 'combined': return show.blendedScore;
    case 'critics': return show.compositeScore;
    case 'audience': return show.audienceCombinedScore;
  }
}

function badgeFromScore(score: number | null | undefined): TierBadge {
  if (!score || score <= 0) return 'eligible';
  if (score <= 40) return 'nominated';
  if (score <= 69) return 'honored';
  if (score <= 84) return 'decorated';
  return 'sweeper';
}

// Shared style tokens — mirrors nominees page
const BOX_MD = 'w-14 h-14 text-2xl rounded-xl flex items-center justify-center font-bold';
const HEADER_LINE = 'text-[9px] font-semibold uppercase tracking-wide text-gray-500 block leading-none';

function AudienceBox({ grade }: { grade: SerializedTonyShow['audienceGrade'] }) {
  if (!grade || grade.grade === '—') {
    return <div className={`${BOX_MD} bg-surface-overlay text-gray-500`}>—</div>;
  }
  const isAplus = grade.grade === 'A+';
  return (
    <div
      className={`${BOX_MD} shadow-sm ${isAplus ? 'audience-top-grade' : ''}`}
      style={isAplus ? undefined : { backgroundColor: grade.color, color: grade.textColor }}
      title={grade.tooltip}
    >
      {grade.grade}
    </div>
  );
}

// Mirrors nominees-page OddsCol: percentage with ▲/▼ change indicator in a rounded box.
// Box dimensions match BOX_MD (w-14 h-14) so the odds visually align with critic/audience score badges.
function OddsCol({ odds, change }: { odds: number | null | undefined; change?: number | null }) {
  const changeRaw = change != null ? Math.abs(change) : 0;
  const changeDisplay = changeRaw >= 0.005
    ? (changeRaw * 100 < 1 ? `${(changeRaw * 100).toFixed(1)}` : `${Math.round(changeRaw * 100)}`)
    : null;
  return (
    <div className="flex-shrink-0 w-14 flex items-center justify-center">
      <div className="relative flex items-center justify-center bg-surface-overlay rounded-xl w-14 h-14">
        <span className="text-base font-bold text-white leading-none">
          {odds != null ? `${Math.round(odds * 100)}%` : '—'}
        </span>
        <span className={`absolute bottom-1 text-[8px] font-semibold leading-none ${changeDisplay != null ? (change! > 0 ? 'text-emerald-400' : 'text-red-400') : odds != null ? 'text-white/20' : 'text-transparent'}`}>
          {changeDisplay != null ? `${change! > 0 ? '▲' : '▼'}${changeDisplay}%` : odds != null ? '–' : '–'}
        </span>
      </div>
    </div>
  );
}

// Our Pick % box — same dimensions as OddsCol, with golden-rim styling for the predicted winner.
function OurPickCol({ pct, isWinner }: { pct: number | null; isWinner: boolean }) {
  return (
    <div className="flex-shrink-0 w-14 flex items-center justify-center">
      <div className={`flex items-center justify-center rounded-xl w-14 h-14 ${isWinner ? 'bg-amber-500/10 border border-amber-500/40' : 'bg-surface-overlay'}`}>
        <span className={`text-base font-bold leading-none ${isWinner ? 'text-amber-400' : pct != null ? 'text-white' : 'text-gray-500'}`}>
          {pct != null ? `${pct}%` : '—'}
        </span>
      </div>
    </div>
  );
}

// Column header row for combined mode — labels align with data columns below.
// CRITICAL: ALL header columns must be in ONE inner flex container with gap-2
// so data rows can mirror it exactly for pixel-perfect alignment.
function CombinedColumnHeader() {
  return (
    <div className="flex items-end gap-3 px-3 pr-5 sm:px-4 sm:pr-6 pt-2 pb-1.5 border-b border-white/5">
      <div className="w-16 sm:w-20 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 max-w-[100px] sm:max-w-none" />
      <div className="flex items-end gap-2 flex-shrink-0">
        <div className="w-14 text-center">
          <span className={HEADER_LINE}>Our</span><span className={HEADER_LINE}>Pick</span>
        </div>
        <div className="flex flex-col items-center w-14">
          <span className={HEADER_LINE}>Gold</span><span className={HEADER_LINE}>Derby</span>
        </div>
        <div className="flex flex-col items-center w-14">
          <span className={HEADER_LINE}>Kalshi</span><span className={HEADER_LINE}>&nbsp;</span>
        </div>
        <div className="flex flex-col items-center w-14">
          <span className={HEADER_LINE}>Poly</span><span className={HEADER_LINE}>market</span>
        </div>
        <div className="w-14 text-center">
          <span className={HEADER_LINE}>Critic</span><span className={HEADER_LINE}>Score</span>
        </div>
        <div className="w-14 text-center">
          <span className={HEADER_LINE}>Audience</span><span className={HEADER_LINE}>Grade</span>
        </div>
        <div className="w-14 text-center" title="Award Score: combined momentum from Drama League, Outer Critics Circle, and Drama Desk">
          <span className={HEADER_LINE}>Award</span><span className={HEADER_LINE}>Score</span>
        </div>
        <div className="hidden sm:flex flex-col items-center w-20" title="Won the matching category at Drama League (DL), Outer Critics Circle (OCC), or Drama Desk (DD)">
          <span className={HEADER_LINE}>Precursor</span><span className={HEADER_LINE}>Awards</span>
        </div>
        <div className="flex flex-col items-center w-14" title="Press picks: New York Times, Variety, and Deadline predictions">
          <span className={HEADER_LINE}>Press</span><span className={HEADER_LINE}>Picks</span>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  show: SerializedTonyShow;
  rank: number | null;
  isUpcoming: boolean;
  globalIndex: number;
  outcomes?: Record<string, 'winner' | 'nominated'>;
  winProbability?: number;
  mode: PredictionMode;
}

function ShowRow({ show, rank, isUpcoming, globalIndex, outcomes, winProbability, mode }: RowProps) {
  const notYetOpen = getEffectiveStatus(show) === 'announced';

  const titleArea = (
    <div className="flex-1 min-w-0 max-w-[100px] sm:max-w-none">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className={`font-bold text-sm sm:text-base group-hover:text-brand transition-colors truncate w-full sm:w-auto ${notYetOpen ? 'text-gray-400' : 'text-white'}`}>
          {show.title}
        </h3>
        {rank === 1 && mode === 'combined' && !isUpcoming && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 rounded border border-amber-500/40">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" />
            </svg>
            Predicted
          </span>
        )}
        {outcomes?.[show.slug] === 'winner' && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wide bg-amber-500/15 text-amber-400 rounded border border-amber-500/20">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" /></svg>
            Winner
          </span>
        )}
      </div>
      {show.precursorWins && show.precursorWins.length > 0 && (
        <div className="sm:hidden flex flex-row gap-1 mt-0.5">
          {show.precursorWins.map(w => (
            <span key={w} title={`Won ${PRECURSOR_LABELS[w] ?? w} in this category`} className="text-[10px] font-semibold text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-1 py-0.5 leading-none">
              {w}
            </span>
          ))}
        </div>
      )}
      {notYetOpen && <p className="text-xs text-gray-500 mt-1">Opening {formatDate(show.openingDate)}</p>}
    </div>
  );

  const thumbnail = (
    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
      {show.thumbnailPath ? (
        <img
          src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
          alt={`${show.title} ${getMarketLabel()} show`}
          className="w-full h-full object-cover"
          width={80}
          height={80}
          loading={globalIndex < 3 ? 'eager' : 'lazy'}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-2xl">🎭</div>
      )}
    </div>
  );

  if (mode === 'combined') {
    const ourPct = winProbability != null ? Math.round(winProbability * 100) : null;
    return (
      <Link
        href={`/show/${show.slug}`}
        className={`flex items-center gap-3 px-3 pr-5 sm:px-4 sm:pr-6 py-3 sm:py-4 hover:bg-white/[0.03] transition-colors group ${notYetOpen ? 'opacity-60' : ''}`}
      >
        {thumbnail}
        {titleArea}
        {/* ALL right-side columns in ONE flex group — must mirror CombinedColumnHeader inner gap-2 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <OurPickCol pct={ourPct} isWinner={rank === 1 && !isUpcoming} />
          <OddsCol odds={show.gdOdds} change={show.gdOddsChange} />
          <OddsCol odds={show.kalshiOdds} change={show.kalshiOddsChange} />
          <OddsCol odds={show.polymarketOdds} change={show.polymarketOddsChange} />
          <ScoreBadge score={show.compositeScore} size="md" reviewCount={show.reviewCount} status={show.status} />
          <AudienceBox grade={show.audienceGrade} />
          <div title="Award Score: momentum from precursor ceremonies (Drama League, Outer Critics Circle, Drama Desk)">
            <AwardScoreBadge
              score={Math.round(show.awardsScore ?? 0)}
              badge={badgeFromScore(show.awardsScore)}
              inProgress={true}
              size="md"
            />
          </div>
          <div className="hidden sm:flex w-20 items-center justify-center">
            <PrecursorChips wins={show.precursorWins} />
          </div>
          <div className="flex w-14 items-center justify-center">
            <PressPicks picks={show.criticPicks} />
          </div>
        </div>
      </Link>
    );
  }

  if (mode === 'critics') {
    const tier = getScoreTier(show.compositeScore);
    return (
      <Link
        href={`/show/${show.slug}`}
        className={`flex items-center gap-3 px-3 sm:px-4 py-3 sm:py-4 hover:bg-white/[0.03] transition-colors group ${notYetOpen ? 'opacity-60' : ''}`}
      >
        {thumbnail}
        {titleArea}
        <div className="flex flex-col items-center gap-1 flex-shrink-0">
          {tier && (
            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: tier.color }}>
              {tier.label}
            </span>
          )}
          <ScoreBadge score={show.compositeScore} size="lg" showCrown reviewCount={show.reviewCount} status={show.status} />
        </div>
      </Link>
    );
  }

  // audience mode
  return (
    <Link
      href={`/show/${show.slug}`}
      className={`flex items-center gap-3 px-3 sm:px-4 py-3 sm:py-4 hover:bg-white/[0.03] transition-colors group ${notYetOpen ? 'opacity-60' : ''}`}
    >
      {thumbnail}
      {titleArea}
      <div className="flex-shrink-0">
        <AudienceBox grade={show.audienceGrade} />
      </div>
    </Link>
  );
}

export default function TonyPredictionsTable({ title, description, shows, upcoming, sectionId, startIndex = 0, outcomes, categoryOutcome, ineligible, mode = 'combined' }: TonyPredictionsTableProps) {
  const scored = useMemo(() => {
    return [...shows].sort((a, b) => {
      const sa = getScoreForMode(a, mode);
      const sb = getScoreForMode(b, mode);
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sb - sa;
    });
  }, [shows, mode]);

  const winProbabilities = useMemo(
    () => mode === 'combined' ? computeWinProbabilities(scored, mode) : new Map<string, number>(),
    [scored, mode]
  );

  const upcomingSorted = [...upcoming].sort((a, b) =>
    (a.openingDate || '').localeCompare(b.openingDate || '')
  );
  const allShows = [...scored, ...upcomingSorted];

  if (allShows.length === 0) return null;

  return (
    <section className="mb-6" id={sectionId}>
      {/* Category heading — small uppercase to match Nominations Center */}
      <div className="mb-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</h2>
          {categoryOutcome && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${
              categoryOutcome.status === 'correct'
                ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/40'
                : 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40'
            }`}>
              {categoryOutcome.status === 'correct' ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Correct
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Missed{categoryOutcome.winnerRank ? ` (#${categoryOutcome.winnerRank})` : ''}
                </>
              )}
            </span>
          )}
        </div>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
        {categoryOutcome?.status === 'missed' && (
          <p className="text-xs text-gray-400 mt-1">
            Winner: <span className="text-white font-medium">{categoryOutcome.winnerTitle}</span>
            {categoryOutcome.predictedTitle && (
              <> · We picked <span className="text-gray-300">{categoryOutcome.predictedTitle}</span></>
            )}
          </p>
        )}
      </div>

      {/* Unified card — horizontally scrollable on mobile to match Nominations Center */}
      <div className="relative">
        <div className="overflow-x-auto">
          <div className={`bg-surface-raised rounded-xl border border-white/5 divide-y divide-white/5 ${mode === 'combined' ? 'min-w-[860px]' : ''}`}>
            {mode === 'combined' && <CombinedColumnHeader />}
            {allShows.map((show, i) => {
              const isUpcoming = upcoming.some(u => u.slug === show.slug);
              const rank = !isUpcoming ? i + 1 : null;
              return (
                <ShowRow
                  key={show.slug}
                  show={show}
                  rank={rank}
                  isUpcoming={isUpcoming}
                  globalIndex={startIndex + i}
                  outcomes={outcomes}
                  winProbability={winProbabilities.get(show.slug)}
                  mode={mode}
                />
              );
            })}
          </div>
        </div>
        {/* Scroll hint: fade on right edge, mobile only */}
        {mode === 'combined' && (
          <div className="sm:hidden absolute inset-y-0 right-0 w-10 pointer-events-none bg-gradient-to-l from-[#1a1a24] to-transparent rounded-r-xl" />
        )}
      </div>

      {/* Ruled-ineligible footer */}
      {ineligible && ineligible.length > 0 && (
        <div className="mt-4 pt-4 border-t border-white/5">
          <h3 className="text-xs uppercase tracking-wide text-gray-500 font-medium mb-2">
            Ruled ineligible by the Tony Administration Committee
          </h3>
          <ul className="space-y-1.5">
            {ineligible.map(item => (
              <li key={item.slug} className="text-sm">
                <Link href={`/show/${item.slug}`} className="text-gray-300 hover:text-white font-medium">
                  {item.title}
                </Link>
                <span className="text-gray-500"> — {item.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
