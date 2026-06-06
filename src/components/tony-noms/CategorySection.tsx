import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge, AwardScoreBadge } from '@/components/show-cards';
import type { TierBadge } from '@/lib/awards-scoring';
import { getOutletConfig, getOutletLogoUrl } from '@/config/outlet-logos';
import type { TonyCategory } from '@/lib/data-tony-predictions';
import { featureFlags } from '@/config/feature-flags';

const SHOW_OUR_PICK = featureFlags.tonyPredictionsOurPick;

export const SHOW_LEVEL_CATEGORIES = new Set([
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
]);

export const PERSON_LEVEL_CATEGORIES = new Set([
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
]);

// All rendered boxes use w-11 h-11 text-lg for visual harmony. ScoreBadge/AwardScoreBadge size="sm" matches.
const BOX_MD = 'w-11 h-11 text-lg lg:w-[68px] lg:h-[68px] lg:text-3xl rounded-lg flex items-center justify-center font-bold';
const BOX_SM = 'w-11 h-11 text-lg lg:w-[68px] lg:h-[68px] lg:text-3xl rounded-lg flex items-center justify-center font-bold';
const HEADER_LINE = 'text-[9px] font-semibold uppercase tracking-wide text-gray-500 block leading-none';

type ShowGrade = TonyCategory['shows'][number]['audienceGrade'];

function AudienceBox({ grade, size }: { grade: ShowGrade; size: 'sm' | 'md' }) {
  const boxClass = size === 'md' ? BOX_MD : BOX_SM;
  if (!grade || grade.grade === '—') {
    return <div className={`${boxClass} bg-surface-overlay text-gray-500`}>—</div>;
  }
  const isAplus = grade.grade === 'A+';
  return (
    <div
      className={`${boxClass} shadow-sm ${isAplus ? 'audience-top-grade' : ''}`}
      style={isAplus ? undefined : { backgroundColor: grade.color, color: grade.textColor }}
      title={grade.tooltip}
    >
      {grade.grade}
    </div>
  );
}

function badgeFromScore(score: number | null | undefined): TierBadge {
  if (!score || score <= 0) return 'eligible';
  if (score <= 40) return 'nominated';
  if (score <= 69) return 'honored';
  if (score <= 84) return 'decorated';
  return 'sweeper';
}

function OddsCol({ odds, change, size }: { odds: number | null | undefined; change?: number | null; size: 'sm' | 'md' }) {
  // Both sizes use w-11 to match ScoreBadge sm dimensions (44px) so the prediction-percent
  // boxes visually match the critic/audience score boxes in the same row. Boxes grow to
  // w-[68px] on lg viewports (desktop). Number + change indicator stack vertically and
  // are centered together so they read as one unit (instead of the change floating at
  // the bottom edge of the box).
  const boxClass = 'w-11 h-11 lg:w-[68px] lg:h-[68px]';
  const numClass = 'text-sm lg:text-xl font-bold text-white leading-none';
  const changeRaw = change != null ? Math.abs(change) : 0;
  const changeDisplay = changeRaw >= 0.005
    ? (changeRaw * 100 < 1 ? `${(changeRaw * 100).toFixed(1)}` : `${Math.round(changeRaw * 100)}`)
    : null;
  return (
    <div className="flex-shrink-0 w-11 lg:w-[68px] flex items-center justify-center">
      <div className={`flex flex-col items-center justify-center gap-0.5 bg-surface-overlay rounded-lg ${boxClass}`}>
        <span className={numClass}>{odds != null ? `${Math.round(odds * 100)}%` : '—'}</span>
        <span className={`text-[8px] lg:text-[10px] font-semibold leading-none ${changeDisplay != null ? (change! > 0 ? 'text-emerald-400' : 'text-red-400') : odds != null ? 'text-white/20' : 'text-transparent'}`}>
          {changeDisplay != null ? `${change! > 0 ? '▲' : '▼'}${changeDisplay}%` : odds != null ? '–' : '–'}
        </span>
      </div>
    </div>
  );
}

// Our model's win probability. All boxes carry a subtle gold tint so the column
// reads as "ours" vs the neutral market-odds columns (GD/Kalshi/Polymarket);
// the #1 pick gets a stronger gradient + gold border to call it out.
function OurPickBox({ winProbability, isWinner }: { winProbability: number | null | undefined; isWinner: boolean }) {
  const pct = winProbability != null ? Math.round(winProbability * 100) : null;
  const baseTintStyle: React.CSSProperties = { background: 'rgba(245, 158, 11, 0.08)' };
  if (pct == null) {
    return (
      <div className="w-11 lg:w-[68px] flex items-center justify-center flex-shrink-0">
        <div
          className="w-11 h-11 lg:w-[68px] lg:h-[68px] rounded-lg flex items-center justify-center border border-amber-400/15 text-amber-400/40 text-sm lg:text-xl font-bold"
          style={baseTintStyle}
        >—</div>
      </div>
    );
  }
  const winnerClass = 'shadow-md shadow-amber-500/20 border border-amber-400/50 text-amber-300';
  const winnerStyle: React.CSSProperties = { background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(217, 119, 6, 0.35))' };
  const nonWinnerClass = 'border border-amber-400/20 text-amber-300';
  return (
    <div className="w-11 lg:w-[68px] flex items-center justify-center flex-shrink-0">
      <div
        className={`w-11 h-11 lg:w-[68px] lg:h-[68px] rounded-lg flex items-center justify-center font-bold text-sm lg:text-xl leading-none ${isWinner ? winnerClass : nonWinnerClass}`}
        style={isWinner ? winnerStyle : baseTintStyle}
        title="Our model's win probability — critic, audience, and precursor signal."
      >
        {pct}%
      </div>
    </div>
  );
}

function PredictedWinnerPill() {
  return (
    <span
      className="flex-shrink-0 inline-flex items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 bg-amber-400/15 border border-amber-400/50 rounded leading-none"
      title="Predicted Winner — our model's #1 pick"
    >
      <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 1l2.39 4.84L17.3 6.9l-3.65 3.56.86 5.03L10 13.26l-4.51 2.23.86-5.03L2.7 6.9l4.91-.96L10 1z" />
      </svg>
      <span className="lg:hidden">Predicted</span>
      <span className="hidden lg:inline">Predicted Winner</span>
    </span>
  );
}

const PRECURSOR_LABELS: Record<string, string> = { DL: 'Drama League', OCC: 'Outer Critics Circle', DD: 'Drama Desk' };

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

const CRITIC_PICK_OUTLETS: Record<string, { outletName: string; critic: string }> = {
  nyt:          { outletName: 'The New York Times',    critic: 'Helen Shaw' },
  variety:      { outletName: 'Variety',               critic: 'Clayton Davis' },
  culturesauce: { outletName: 'Culture Sauce',         critic: 'Thom Geier' },
  nytg:         { outletName: 'New York Theatre Guide', critic: 'Mickey-Jo Theatre' },
  ew:           { outletName: 'Entertainment Weekly',  critic: 'Dalton Ross' },
  nysun:        { outletName: 'The New York Sun',      critic: 'Elysa Gardner' },
  theatermania: { outletName: 'TheaterMania',          critic: 'TheaterMania Staff' },
  slant:        { outletName: 'Slant Magazine',        critic: 'Dan Rubins' },
  timeout:      { outletName: 'Time Out New York',     critic: 'Adam Feldman' },
  thr:          { outletName: 'The Hollywood Reporter', critic: 'Ben Zauzmer' },
  deadline:     { outletName: 'Deadline',              critic: 'Greg Evans' },
  cityguide:    { outletName: 'City Guide New York',   critic: 'Griffin Miller' },
  vf:           { outletName: 'Vanity Fair',           critic: 'Little Gold Men' },
  elle:         { outletName: 'Elle',                  critic: 'Samuel Maude' },
  bg:           { outletName: 'Boston Globe',          critic: 'Christopher Wallenberg' },
  nytpaulson:   { outletName: 'The New York Times',    critic: 'Michael Paulson' },
  chitrib:      { outletName: 'Chicago Tribune',       critic: 'Chris Jones' },
  thewrap:      { outletName: 'The Wrap',              critic: 'Robert Hofler' },
  parade:       { outletName: 'Parade',               critic: 'Jessica Sager' },
  timesuk:      { outletName: 'The Times (UK)',        critic: 'Ben Kawaller' },
  rbroadway:    { outletName: 'r/Broadway',           critic: 'Community vote · 320+ fans' },
  '1minutecritic': { outletName: '1 Minute Critic',      critic: 'Matthew Wexler' },
};

// Cap the number of rendered avatars so the chip cluster stays one row tall.
// At w-5 (20px) + gap-0.5 (2px), four items = 86px, which fits the 88px max
// width. Without this cap, front-runners that collect many critic picks during
// Tony season (e.g. 9 picks) wrap to 3 rows and inflate the surrounding row
// past its compact-height guard (tests/e2e/tony-nominees-row-height.spec.ts).
function PressPicks({ picks }: { picks?: string[] }) {
  if (!picks || picks.length === 0) return null;
  const knownPicks = picks.filter(id => CRITIC_PICK_OUTLETS[id]);
  if (knownPicks.length === 0) return null;
  // Wrap all outlet logos (6 per row at 16px) rather than collapsing behind a
  // "+N" chip — every outlet's logo stays visible. Chips are 16px (not 20px) so
  // that near-unanimous categories (e.g. 12 outlets picking Joshua Henry) wrap to
  // 2 rows, keeping the performer row under the 70px row-height guard
  // (tests/e2e/tony-nominees-row-height.spec.ts).
  return (
    <div className="flex flex-wrap items-center justify-center gap-0.5 max-w-[112px]">
      {knownPicks.map(id => {
        const meta = CRITIC_PICK_OUTLETS[id];
        const logoUrl = getOutletLogoUrl(meta.outletName);
        const config = getOutletConfig(meta.outletName);
        const title = `${meta.outletName} (${meta.critic}) picks this show to win`;
        if (logoUrl) {
          return (
            <div key={id} className="w-4 h-4 rounded-full bg-white flex items-center justify-center flex-shrink-0 overflow-hidden" title={title}>
              <img src={logoUrl} alt={meta.outletName} className="w-3 h-3 object-contain" />
            </div>
          );
        }
        const abbrev = config?.abbrev || meta.outletName.charAt(0);
        const bgColor = config?.color || '#374151';
        const textSize = abbrev.length > 2 ? 'text-[6px]' : 'text-[8px]';
        return (
          <div
            key={id}
            className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${textSize} font-bold text-white leading-none`}
            style={{ backgroundColor: bgColor }}
            title={title}
          >
            {abbrev}
          </div>
        );
      })}
    </div>
  );
}

function SectionColumnHeader({ isMajor, isPersonLevel = false, hideMarketOdds = false }: { isMajor: boolean; isPersonLevel?: boolean; hideMarketOdds?: boolean }) {
  const thumbnailW = isMajor ? 'w-16 sm:w-20' : 'w-11 sm:w-12';
  const scoreW = 'w-11 lg:w-[68px]';
  const padding = isMajor ? 'px-3 pr-5 sm:px-4 sm:pr-6' : 'px-2.5 sm:px-3';
  const titleMaxW = isMajor ? 'max-w-[100px] sm:max-w-none' : !isPersonLevel ? 'max-w-[90px] sm:max-w-none' : 'max-w-[80px] sm:max-w-none';

  return (
    <div className={`flex items-end gap-3 ${padding} pt-2 pb-1.5 border-b border-white/5`}>
      <div className={`${thumbnailW} flex-shrink-0`} aria-hidden="true" />
      <div className={`flex-1 min-w-0 ${titleMaxW}`} />
      <div className="flex items-end gap-2 flex-shrink-0">
        {SHOW_OUR_PICK && isMajor && (
          <div className="flex flex-col items-center w-11 lg:w-[68px]">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-400/80 block leading-none">Our</span>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-400/80 block leading-none">Pick</span>
          </div>
        )}
        {!hideMarketOdds && (
          <>
            <div className="flex flex-col items-center w-11 lg:w-[68px]">
              <span className={HEADER_LINE}>Gold</span><span className={HEADER_LINE}>Derby</span>
            </div>
            <div className="flex flex-col items-center w-11 lg:w-[68px]">
              <span className={HEADER_LINE}>Kalshi</span><span className={HEADER_LINE}>&nbsp;</span>
            </div>
            <div className="flex flex-col items-center w-11 lg:w-[68px]">
              <span className={HEADER_LINE}>Poly</span><span className={HEADER_LINE}>market</span>
            </div>
          </>
        )}
        {!isPersonLevel && (
          <>
            <div className={`${scoreW} text-center ml-3 sm:ml-4`}>
              <span className={HEADER_LINE}>Critic</span><span className={HEADER_LINE}>Score</span>
            </div>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Audience</span><span className={HEADER_LINE}>Grade</span>
            </div>
          </>
        )}
        {!isPersonLevel && (
          <>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Award</span><span className={HEADER_LINE}>Score</span>
            </div>
            <div className="hidden sm:flex flex-col items-center w-20">
              <span className={HEADER_LINE}>Precursor</span><span className={HEADER_LINE}>Awards</span>
            </div>
            <div className="flex flex-col items-center w-28">
              <span className={HEADER_LINE}>Press</span><span className={HEADER_LINE}>Picks</span>
            </div>
          </>
        )}
        {isPersonLevel && (
          <>
            <div className="hidden sm:flex flex-col items-center w-20 ml-3 sm:ml-4">
              <span className={HEADER_LINE}>Precursor</span><span className={HEADER_LINE}>Awards</span>
            </div>
            <div className="flex flex-col items-center w-28">
              <span className={HEADER_LINE}>Press</span><span className={HEADER_LINE}>Picks</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MajorNomineeRow({ show, winProbability, rank, ceremonyDate, hideMarketOdds = false }: { show: TonyCategory['shows'][number]; winProbability?: number; rank?: number; ceremonyDate: string | null; hideMarketOdds?: boolean }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex items-center gap-3 sm:gap-4 p-3 pr-5 sm:p-4 sm:pr-6 rounded-xl hover:bg-white/[0.03] transition-colors group"
    >
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
        {show.thumbnailPath ? (
          <img
            src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={80}
            height={80}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl">🎭</div>
        )}
      </div>
      <div className="flex-1 min-w-0 max-w-[100px] sm:max-w-none">
        <h3 className="text-sm sm:text-base font-bold text-white truncate group-hover:text-brand transition-colors">
          {show.title}
        </h3>
        {(SHOW_OUR_PICK && rank === 1) || (show.precursorWins && show.precursorWins.length > 0) ? (
          <div className="flex flex-wrap gap-1 mt-1">
            {SHOW_OUR_PICK && rank === 1 && <PredictedWinnerPill />}
            {show.precursorWins?.map(w => (
              <span key={w} title={`Won ${PRECURSOR_LABELS[w] ?? w} in this category`} className="sm:hidden text-[10px] font-semibold text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-1 py-0.5 leading-none">
                {w}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {SHOW_OUR_PICK && <OurPickBox winProbability={winProbability} isWinner={rank === 1} />}
        {!hideMarketOdds && (
          <>
            <OddsCol odds={show.gdOdds} change={show.gdOddsChange} size="md" />
            <OddsCol odds={show.kalshiOdds} change={show.kalshiOddsChange} size="md" />
            <OddsCol odds={show.polymarketOdds} change={show.polymarketOddsChange} size="md" />
          </>
        )}
        <div className="ml-3 sm:ml-4">
          <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
        </div>
        <AudienceBox grade={show.audienceGrade} size="md" />
        <AwardScoreBadge
          score={Math.round(show.awardsScore ?? 0)}
          badge={badgeFromScore(show.awardsScore)}
          inProgress={!ceremonyDate || new Date() < new Date(`${ceremonyDate}T12:00:00Z`)}
          size="sm"
        />
        <div className="hidden sm:flex w-20 items-center justify-center">
          <PrecursorChips wins={show.precursorWins} />
        </div>
        <div className="flex w-28 items-center justify-center">
          <PressPicks picks={show.criticPicks} />
        </div>
      </div>
    </Link>
  );
}

function PerformerRow({ show, hideMarketOdds = false }: { show: TonyCategory['shows'][number]; hideMarketOdds?: boolean }) {
  const priorNoms = show.nomineePriorNominations ?? 0;
  const priorWins = show.nomineePriorWins ?? 0;

  let historyLabel: string;
  if (priorNoms === 0) {
    historyLabel = 'First Tony nomination';
  } else if (priorWins > 0) {
    historyLabel = `${priorNoms}× nominated · ${priorWins}× winner`;
  } else {
    historyLabel = `${priorNoms}× nominated`;
  }

  const actorUrl = show.nomineeActorSlug ? `/cast/${show.nomineeActorSlug}` : null;

  return (
    <div className="performer-row flex items-center gap-2.5 px-3 py-1.5 sm:p-2.5 hover:bg-white/[0.03] transition-colors">
      <Link
        href={`/show/${show.slug}`}
        className="w-10 h-10 sm:w-11 sm:h-11 rounded-md overflow-hidden bg-surface-raised flex-shrink-0"
        tabIndex={-1}
        aria-hidden="true"
      >
        {show.thumbnailPath ? (
          <img
            src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
            alt=""
            className="w-full h-full object-cover"
            width={48}
            height={48}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm">🎭</div>
        )}
      </Link>
      <div className="flex-1 min-w-0 max-w-[80px] sm:max-w-none">
        <div className="hidden sm:flex items-baseline gap-1.5 min-w-0">
          {actorUrl ? (
            <Link href={actorUrl} className="text-sm font-bold text-white hover:text-brand transition-colors flex-shrink-0">
              {show.nomineePersonName}
            </Link>
          ) : (
            <span className="text-sm font-bold text-white flex-shrink-0">{show.nomineePersonName}</span>
          )}
          <span className="text-[10px] text-gray-500 truncate min-w-0">{historyLabel}</span>
        </div>
        <div className="sm:hidden">
          {actorUrl ? (
            <Link href={actorUrl} className="text-sm font-bold text-white hover:text-brand transition-colors leading-tight block truncate">
              {show.nomineePersonName}
            </Link>
          ) : (
            <span className="text-sm font-bold text-white leading-tight block truncate">{show.nomineePersonName}</span>
          )}
        </div>
        <Link href={`/show/${show.slug}`} className="text-xs text-gray-400 hover:text-gray-300 transition-colors block truncate mt-0.5">
          {show.title}
        </Link>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {!hideMarketOdds && (
          <>
            <OddsCol odds={show.gdOdds} change={show.gdOddsChange} size="sm" />
            <OddsCol odds={show.kalshiOdds} change={show.kalshiOddsChange} size="sm" />
            <OddsCol odds={show.polymarketOdds} change={show.polymarketOddsChange} size="sm" />
          </>
        )}
        <div className="hidden sm:flex w-20 items-center justify-center ml-3 sm:ml-4">
          <PrecursorChips wins={show.precursorWins} />
        </div>
        <div className="flex w-28 items-center justify-center">
          <PressPicks picks={show.criticPicks} />
        </div>
      </div>
    </div>
  );
}

function CraftRow({ show, ceremonyDate, hideMarketOdds = false }: { show: TonyCategory['shows'][number]; ceremonyDate: string | null; hideMarketOdds?: boolean }) {
  return (
    <div className="craft-row flex items-center gap-3 p-2.5 sm:p-3 rounded-lg hover:bg-white/[0.03] transition-colors">
      <Link
        href={`/show/${show.slug}`}
        className="w-11 h-11 sm:w-12 sm:h-12 rounded-md overflow-hidden bg-surface-raised flex-shrink-0"
        tabIndex={-1}
        aria-hidden="true"
      >
        {show.thumbnailPath ? (
          <img
            src={getOptimizedImageUrl(show.thumbnailPath, 'thumbnail')}
            alt=""
            className="w-full h-full object-cover"
            width={48}
            height={48}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm">🎭</div>
        )}
      </Link>
      <div className="flex-1 min-w-0 max-w-[90px] sm:max-w-none">
        <Link href={`/show/${show.slug}`} className="text-sm font-bold text-white hover:text-brand transition-colors block truncate">
          {show.title}
        </Link>
        {show.nomineePersonName && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{show.nomineePersonName}</p>
        )}
        {show.precursorWins && show.precursorWins.length > 0 && (
          <div className="sm:hidden flex flex-row gap-1 mt-0.5">
            {show.precursorWins.map(w => (
              <span key={w} title={`Won ${PRECURSOR_LABELS[w] ?? w} in this category`} className="text-[10px] font-semibold text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-1 py-0.5 leading-none">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {!hideMarketOdds && (
          <>
            <OddsCol odds={show.gdOdds} change={show.gdOddsChange} size="sm" />
            <OddsCol odds={show.kalshiOdds} change={show.kalshiOddsChange} size="sm" />
            <OddsCol odds={show.polymarketOdds} change={show.polymarketOddsChange} size="sm" />
          </>
        )}
        <div className="ml-3 sm:ml-4">
          <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
        </div>
        <AudienceBox grade={show.audienceGrade} size="sm" />
        <AwardScoreBadge
          score={Math.round(show.awardsScore ?? 0)}
          badge={badgeFromScore(show.awardsScore)}
          inProgress={!ceremonyDate || new Date() < new Date(`${ceremonyDate}T12:00:00Z`)}
          size="sm"
        />
        <div className="hidden sm:flex w-20 items-center justify-center">
          <PrecursorChips wins={show.precursorWins} />
        </div>
        <div className="flex w-28 items-center justify-center">
          <PressPicks picks={show.criticPicks} />
        </div>
      </div>
    </div>
  );
}

export interface CategoryOutcome {
  status: 'correct' | 'missed';
  winnerTitle: string;
  winnerRank: number | null;
  predictedTitle: string | null;
}

export function CategorySection({ category, winProbs, ceremonyDate, sectionId, description, categoryOutcome, ineligible, hideMarketOdds = false }: {
  category: TonyCategory;
  winProbs?: Map<string, number>;
  ceremonyDate: string | null;
  sectionId?: string;
  description?: string;
  categoryOutcome?: CategoryOutcome;
  ineligible?: Array<{ slug: string; title: string; note: string }>;
  /** When true, hide GD/Kalshi/Polymarket odds columns. Used by past-season Predictions
   *  pages where the markets are closed and the columns would render all '—'. */
  hideMarketOdds?: boolean;
}) {
  const isMajor = SHOW_LEVEL_CATEGORIES.has(category.title);
  const isPersonLevel = PERSON_LEVEL_CATEGORIES.has(category.title);
  // When Our Pick is live, re-sort major-category nominees by win probability desc.
  const nominees = (SHOW_OUR_PICK && isMajor && winProbs)
    ? [...category.shows].sort((a, b) => (winProbs.get(b.slug) ?? 0) - (winProbs.get(a.slug) ?? 0))
    : category.shows;

  if (nominees.length === 0) return null;

  // Min-width: base values cover mobile (w-11 boxes), lg variant covers desktop
  // (w-[68px] boxes). Each box grows by 24px on lg; ~24px gap added between odds
  // and score groups. Drops by ~156px (mobile) / 228px (lg) when market odds
  // are hidden (3 boxes × w-11 + gaps). Tailwind JIT requires literal classes.
  let minW: string;
  if (isMajor) {
    if (SHOW_OUR_PICK) minW = hideMarketOdds ? 'min-w-[624px] lg:min-w-[780px]' : 'min-w-[780px] lg:min-w-[1008px]';
    else               minW = hideMarketOdds ? 'min-w-[572px] lg:min-w-[712px]' : 'min-w-[728px] lg:min-w-[940px]';
  } else if (isPersonLevel) {
    minW = hideMarketOdds ? 'min-w-[384px] lg:min-w-[520px]' : 'min-w-[540px] lg:min-w-[748px]';
  } else {
    minW = hideMarketOdds ? 'min-w-[472px] lg:min-w-[612px]' : 'min-w-[628px] lg:min-w-[840px]';
  }

  return (
    <section className="mb-6" id={sectionId}>
      <div className="mb-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            {category.title}
          </h2>
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
      <div className="relative">
      <div className="overflow-x-auto">
      <div className={`bg-surface-raised rounded-xl border border-white/5 divide-y divide-white/5 ${minW}`}>
        <SectionColumnHeader isMajor={isMajor} isPersonLevel={isPersonLevel} hideMarketOdds={hideMarketOdds} />
        {nominees.map((show, index) => {
          const key = show.nomineePersonName
            ? `${show.slug}-${show.nomineePersonName}`
            : show.slug;
          return (
            <div key={key}>
              {isMajor ? (
                <MajorNomineeRow show={show} winProbability={winProbs?.get(show.slug)} rank={index + 1} ceremonyDate={ceremonyDate} hideMarketOdds={hideMarketOdds} />
              ) : isPersonLevel ? (
                <PerformerRow show={show} hideMarketOdds={hideMarketOdds} />
              ) : (
                <CraftRow show={show} ceremonyDate={ceremonyDate} hideMarketOdds={hideMarketOdds} />
              )}
            </div>
          );
        })}
      </div>
      </div>
      <div className="sm:hidden absolute inset-y-0 right-0 w-10 pointer-events-none bg-gradient-to-l from-[#1a1a24] to-transparent rounded-r-xl" />
      </div>
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
