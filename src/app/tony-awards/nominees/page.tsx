import Link from 'next/link';
import type { Metadata } from 'next';
import { getOptimizedImageUrl } from '@/lib/images';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { ScoreBadge, AwardScoreBadge } from '@/components/show-cards';
import type { TierBadge } from '@/lib/awards-scoring';
import { getOutletConfig } from '@/config/outlet-logos';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import type { TonyCategory } from '@/lib/data-tony-predictions';
import { CeremonyCountdown } from '@/components/tony/CeremonyCountdown';

// --- Constants ---

const SHOW_LEVEL_CATEGORIES = new Set([
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
]);

const PERSON_LEVEL_CATEGORIES = new Set([
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
]);

const season = getTonySeasonWindow();
const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
const ceremonyDate = seasonRecord?.ceremonyDate ?? null;

// --- SEO ---

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Nominations Center — Critic, Audience & Odds`,
  description: `Every ${season.label} Tony-nominated show and nominee ranked by critic score, audience grade, and win odds from GoldDerby, Polymarket, and Kalshi. All 26 categories.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards/nominees`,
  },
  openGraph: {
    title: `${season.ceremonyYear} Tony Nominations Center — Broadway Scorecard`,
    description: `All ${season.label} Tony nominees with critic scores, audience grades, and crowd-sourced win odds from GoldDerby, Polymarket, and Kalshi.`,
    url: `${BASE_URL}/tony-awards/nominees`,
    type: 'website',
  },
};

// --- Helpers ---

function formatCeremonyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Shared style tokens
const BOX_MD = 'w-14 h-14 text-2xl rounded-xl flex items-center justify-center font-bold';
const BOX_SM = 'w-11 h-11 text-lg rounded-lg flex items-center justify-center font-bold';
// Two-span pattern: each span uses block+leading-none so line height is controlled by font
const HEADER_LINE = 'text-[9px] font-semibold uppercase tracking-wide text-gray-500 block leading-none';

// --- Reusable score sub-components ---

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

function OddsCol({ odds, size }: { odds: number | null | undefined; size: 'sm' | 'md' }) {
  const numClass = size === 'md' ? 'text-base font-bold text-white' : 'text-sm font-bold text-white';
  return (
    <div className="hidden sm:flex items-center justify-center flex-shrink-0 w-12">
      <span className={numClass}>{odds != null ? `${Math.round(odds * 100)}%` : '—'}</span>
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

const CRITIC_PICK_META: Record<string, { abbrev: string; color: string; label: string }> = {
  nyt:      { abbrev: 'T',  color: '#1a1a1a', label: 'New York Times' },
  variety:  { abbrev: 'V',  color: '#be0028', label: 'Variety' },
  deadline: { abbrev: 'DL', color: '#444444', label: 'Deadline' },
};

function PressPicks({ picks }: { picks?: string[] }) {
  if (!picks || picks.length === 0) return null;
  const knownPicks = picks.filter(id => CRITIC_PICK_META[id]);
  if (knownPicks.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {knownPicks.map(id => {
        const meta = CRITIC_PICK_META[id];
        const cfg = getOutletConfig(meta.label);
        const bgColor = cfg?.color ?? meta.color;
        const textSize = meta.abbrev.length > 2 ? 'text-[7px]' : 'text-[9px]';
        return (
          <div
            key={id}
            className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${textSize} font-bold text-white leading-none`}
            style={{ backgroundColor: bgColor }}
            title={`${meta.label} picks this show to win`}
          >
            {meta.abbrev}
          </div>
        );
      })}
    </div>
  );
}

// Mobile-only compact secondary line: odds + precursor chips + press picks
function MobileOddsLine({ gdOdds, polymarketOdds, kalshiOdds, precursorWins, criticPicks }: {
  gdOdds?: number | null;
  polymarketOdds?: number | null;
  kalshiOdds?: number | null;
  precursorWins?: string[];
  criticPicks?: string[];
}) {
  const hasOdds = gdOdds != null || polymarketOdds != null || kalshiOdds != null;
  const hasPrecursor = (precursorWins?.length ?? 0) > 0;
  const hasPicks = (criticPicks?.filter(id => CRITIC_PICK_META[id])?.length ?? 0) > 0;
  if (!hasOdds && !hasPrecursor && !hasPicks) return null;

  const fmt = (v: number | null | undefined, label: string) =>
    v != null ? <span key={label} className="text-gray-300"><span className="text-gray-600">{label} </span>{Math.round(v * 100)}%</span> : null;

  return (
    <div className="sm:hidden flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
      {fmt(gdOdds, 'GD')}
      {fmt(polymarketOdds, 'PM')}
      {fmt(kalshiOdds, 'K')}
      {hasPrecursor && <PrecursorChips wins={precursorWins} />}
      {hasPicks && <PressPicks picks={criticPicks} />}
    </div>
  );
}

// Column header row — appears once per section inside the card, labels align with data columns
// CRITICAL: ALL header columns must be in ONE inner flex container with gap-2 so data rows can
// wrap their columns in an identical container and maintain pixel-perfect alignment at all widths.
function SectionColumnHeader({ isMajor, isPersonLevel = false }: { isMajor: boolean; isPersonLevel?: boolean }) {
  const thumbnailW = isMajor ? 'w-16 sm:w-20' : 'w-11 sm:w-12';
  const scoreW = isMajor ? 'w-14' : 'w-11';
  const padding = isMajor ? 'px-3 pr-5 sm:px-4 sm:pr-6' : 'px-2.5 sm:px-3';

  return (
    <div className={`flex items-end gap-3 ${padding} pt-2 pb-1.5 border-b border-white/5`}>
      <div className={`${thumbnailW} flex-shrink-0`} aria-hidden="true" />
      <div className="flex-1 min-w-0" />
      {/* ALL right-side columns in ONE flex group with gap-2 — data rows must mirror this exactly */}
      <div className="flex items-end gap-2 flex-shrink-0">
        {/* Odds columns (hidden on mobile) */}
        <div className="hidden sm:flex flex-col items-center w-12">
          <span className={HEADER_LINE}>Gold</span><span className={HEADER_LINE}>Derby</span>
        </div>
        <div className="hidden sm:flex flex-col items-center w-12">
          <span className={HEADER_LINE}>Poly</span><span className={HEADER_LINE}>market</span>
        </div>
        <div className="hidden sm:flex flex-col items-center w-12">
          <span className={HEADER_LINE}>Kalshi</span><span className={HEADER_LINE}>&nbsp;</span>
        </div>
        {/* Score columns — omitted for performer/acting categories */}
        {!isPersonLevel && (isMajor ? (
          <>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Critic</span><span className={HEADER_LINE}>Score</span>
            </div>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Audience</span><span className={HEADER_LINE}>Grade</span>
            </div>
          </>
        ) : (
          <>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Audience</span><span className={HEADER_LINE}>Grade</span>
            </div>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Critic</span><span className={HEADER_LINE}>Score</span>
            </div>
          </>
        ))}
        {!isPersonLevel && (
          <>
            <div className={`${scoreW} text-center`}>
              <span className={HEADER_LINE}>Award</span><span className={HEADER_LINE}>Score</span>
            </div>
            <div className="hidden sm:flex flex-col items-center w-20">
              <span className={HEADER_LINE}>Precursor</span><span className={HEADER_LINE}>Awards</span>
            </div>
            <div className="hidden sm:flex flex-col items-center w-14">
              <span className={HEADER_LINE}>Press</span><span className={HEADER_LINE}>Picks</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- Major category row (Best Musical / Play / Revival) ---

function MajorNomineeRow({ show }: { show: TonyCategory['shows'][number] }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex items-center gap-3 sm:gap-4 p-3 pr-5 sm:p-4 sm:pr-6 rounded-xl hover:bg-white/[0.03] transition-colors group"
    >
      {/* Thumbnail */}
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

      {/* Title + venue + mobile odds */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm sm:text-base font-bold text-white truncate group-hover:text-brand transition-colors">
          {show.title}
        </h3>
        <p className="text-xs text-gray-500 truncate mt-0.5">{show.venue}</p>
        <MobileOddsLine gdOdds={show.gdOdds} polymarketOdds={show.polymarketOdds} kalshiOdds={show.kalshiOdds} precursorWins={show.precursorWins} criticPicks={show.criticPicks} />
      </div>

      {/* ALL right-side columns in ONE flex group — must mirror SectionColumnHeader inner gap-2 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <OddsCol odds={show.gdOdds} size="md" />
        <OddsCol odds={show.polymarketOdds} size="md" />
        <OddsCol odds={show.kalshiOdds} size="md" />
        <ScoreBadge score={show.compositeScore} size="md" reviewCount={show.reviewCount} status={show.status} />
        <AudienceBox grade={show.audienceGrade} size="md" />
        <AwardScoreBadge
          score={Math.round(show.awardsScore ?? 0)}
          badge={badgeFromScore(show.awardsScore)}
          inProgress={!ceremonyDate || new Date() < new Date(`${ceremonyDate}T12:00:00Z`)}
          size="md"
        />
        <div className="hidden sm:flex w-20 items-center justify-center">
          <PrecursorChips wins={show.precursorWins} />
        </div>
        <div className="hidden sm:flex w-14 items-center justify-center">
          <PressPicks picks={show.criticPicks} />
        </div>
      </div>
    </Link>
  );
}

// --- Performer row (acting + directing categories) ---

function PerformerRow({ show }: { show: TonyCategory['shows'][number] }) {
  const priorNoms = show.nomineePriorNominations ?? 0;
  const priorWins = show.nomineePriorWins ?? 0;

  let historyLabel: string;
  if (priorNoms === 0) {
    historyLabel = 'First nomination';
  } else if (priorWins > 0) {
    historyLabel = `${priorNoms}× nominated · ${priorWins}× winner`;
  } else {
    historyLabel = `${priorNoms}× nominated`;
  }

  const actorUrl = show.nomineeActorSlug ? `/cast/${show.nomineeActorSlug}` : null;

  return (
    <div className="flex items-center gap-3 p-2.5 sm:p-3 rounded-lg hover:bg-white/[0.03] transition-colors">
      {/* Thumbnail → show page */}
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

      {/* Performer name + history inline, show name below */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0">
          {actorUrl ? (
            <Link href={actorUrl} className="text-sm font-bold text-white hover:text-brand transition-colors truncate flex-shrink-0">
              {show.nomineePersonName}
            </Link>
          ) : (
            <span className="text-sm font-bold text-white truncate flex-shrink-0">{show.nomineePersonName}</span>
          )}
          <span className="text-[10px] text-gray-500 truncate min-w-0">{historyLabel}</span>
        </div>
        <Link href={`/show/${show.slug}`} className="text-xs text-gray-400 hover:text-gray-300 transition-colors block truncate mt-0.5">
          {show.title}
        </Link>
        <MobileOddsLine gdOdds={show.gdOdds} polymarketOdds={show.polymarketOdds} kalshiOdds={show.kalshiOdds} precursorWins={show.precursorWins} criticPicks={show.criticPicks} />
      </div>

      {/* ALL right-side columns in ONE flex group — must mirror SectionColumnHeader inner gap-2 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <OddsCol odds={show.gdOdds} size="sm" />
        <OddsCol odds={show.polymarketOdds} size="sm" />
        <OddsCol odds={show.kalshiOdds} size="sm" />
      </div>
    </div>
  );
}

// --- Craft row (book, score, choreography, design, etc.) ---

function CraftRow({ show }: { show: TonyCategory['shows'][number] }) {
  return (
    <div className="flex items-center gap-3 p-2.5 sm:p-3 rounded-lg hover:bg-white/[0.03] transition-colors">
      {/* Thumbnail */}
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

      {/* Show name (bold) + credited names (dimmer) */}
      <div className="flex-1 min-w-0">
        <Link href={`/show/${show.slug}`} className="text-sm font-bold text-white hover:text-brand transition-colors block truncate">
          {show.title}
        </Link>
        {show.nomineePersonName && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{show.nomineePersonName}</p>
        )}
        <MobileOddsLine gdOdds={show.gdOdds} polymarketOdds={show.polymarketOdds} kalshiOdds={show.kalshiOdds} precursorWins={show.precursorWins} criticPicks={show.criticPicks} />
      </div>

      {/* ALL right-side columns in ONE flex group — must mirror SectionColumnHeader inner gap-2 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <OddsCol odds={show.gdOdds} size="sm" />
        <OddsCol odds={show.polymarketOdds} size="sm" />
        <OddsCol odds={show.kalshiOdds} size="sm" />
        <AudienceBox grade={show.audienceGrade} size="sm" />
        <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
        <AwardScoreBadge
          score={Math.round(show.awardsScore ?? 0)}
          badge={badgeFromScore(show.awardsScore)}
          inProgress={!ceremonyDate || new Date() < new Date(`${ceremonyDate}T12:00:00Z`)}
          size="sm"
        />
        <div className="hidden sm:flex w-20 items-center justify-center">
          <PrecursorChips wins={show.precursorWins} />
        </div>
        <div className="hidden sm:flex w-14 items-center justify-center">
          <PressPicks picks={show.criticPicks} />
        </div>
      </div>
    </div>
  );
}

// --- Category section ---

function CategorySection({ category }: { category: TonyCategory }) {
  const isMajor = SHOW_LEVEL_CATEGORIES.has(category.title);
  const isPersonLevel = PERSON_LEVEL_CATEGORIES.has(category.title);
  const nominees = category.shows;

  if (nominees.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
        {category.title}
      </h2>
      <div className="bg-surface-raised rounded-xl border border-white/5 divide-y divide-white/5">
        <SectionColumnHeader isMajor={isMajor} isPersonLevel={isPersonLevel} />
        {nominees.map(show => {
          const key = show.nomineePersonName
            ? `${show.slug}-${show.nomineePersonName}`
            : show.slug;
          return (
            <div key={key}>
              {isMajor ? (
                <MajorNomineeRow show={show} />
              ) : isPersonLevel ? (
                <PerformerRow show={show} />
              ) : (
                <CraftRow show={show} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Page ---

export default function TonyNomineesPage() {
  const categories = getNomineesByCategory(season);
  const totalCategories = categories.filter(c => c.shows.length > 0).length;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Nominees', url: `${BASE_URL}/tony-awards/nominees` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Back link */}
        <Link
          href="/tony-awards"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Tony Awards
        </Link>

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Nominations Center
            </h1>
            <p className="text-gray-400 mt-1 text-sm">
              {totalCategories} categories &middot; critic scores, audience grades, and win odds
            </p>
          </div>
          {ceremonyDate && (
            <div className="flex flex-col items-end flex-shrink-0">
              <span className="text-xs font-medium px-3 py-1.5 rounded-full bg-brand/10 text-brand border border-brand/20">
                Ceremony {formatCeremonyDate(ceremonyDate)}
              </span>
              <CeremonyCountdown ceremonyDate={ceremonyDate} />
            </div>
          )}
        </div>

        {/* Announcement banner */}
        <div className="mb-6 px-4 py-3 rounded-xl border border-white/8 bg-surface-raised text-sm">
          <span className="text-brand font-semibold">Predictions being released on Thursday</span>
          {' '}— check back for per-category win probabilities ranked by our critic, audience &amp; awards model.
        </div>

        {/* Category sections */}
        {categories.map(cat => (
          <CategorySection key={cat.key} category={cat} />
        ))}

        {/* Legend */}
        <p className="mt-8 text-xs text-gray-600 text-center">
          Win odds: GoldDerby (crowd predictions) · Polymarket &amp; Kalshi (real-money markets)
        </p>
      </div>
    </>
  );
}
