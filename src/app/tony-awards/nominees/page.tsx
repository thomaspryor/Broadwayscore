import Link from 'next/link';
import type { Metadata } from 'next';
import { getOptimizedImageUrl } from '@/lib/images';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { ScoreBadge, AwardScoreBadge } from '@/components/show-cards';
import type { TierBadge } from '@/lib/awards-scoring';
import { getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import type { TonyCategory } from '@/lib/data-tony-predictions';

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
  'Best Direction of a Musical',
  'Best Direction of a Play',
]);

const season = getTonySeasonWindow();
const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
const ceremonyDate = seasonRecord?.ceremonyDate ?? null;

// --- SEO ---

export const metadata: Metadata = {
  title: `${season.ceremonyYear} Tony Awards Nominees — Critic, Audience & Odds`,
  description: `Every ${season.label} Tony-nominated show and nominee ranked by critic score, audience grade, and win odds from GoldDerby. All 26 categories.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards/nominees`,
  },
  openGraph: {
    title: `${season.ceremonyYear} Tony Nominees — Broadway Scorecard`,
    description: `All ${season.label} Tony nominees with critic scores, audience grades, and crowd-sourced win odds.`,
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
const LABEL = 'text-[9px] font-semibold uppercase tracking-wide text-gray-400';

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

function GoldDerbyCol({ odds, size }: { odds: number | null | undefined; size: 'sm' | 'md' }) {
  const numClass = size === 'md' ? 'text-base font-bold text-white' : 'text-sm font-bold text-white';
  return (
    <div className="hidden sm:flex flex-col items-center gap-1 flex-shrink-0 w-20">
      <span className={LABEL}>Gold Derby</span>
      <span className={numClass}>
        {odds != null ? `${Math.round(odds * 100)}%` : '—'}
      </span>
    </div>
  );
}

// --- Major category row (Best Musical / Play / Revival) ---

function MajorNomineeRow({ show }: { show: TonyCategory['shows'][number] }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl hover:bg-white/[0.03] transition-colors group"
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

      {/* Title + venue */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm sm:text-base font-bold text-white truncate group-hover:text-brand transition-colors">
          {show.title}
        </h3>
        <p className="text-xs text-gray-500 truncate mt-0.5">{show.venue}</p>
      </div>

      {/* Gold Derby column */}
      <GoldDerbyCol odds={show.gdOdds} size="md" />

      {/* Critics | Audience | Awards — all same size */}
      <div className="flex items-start gap-2 flex-shrink-0">
        <div className="flex flex-col items-center gap-1">
          <span className={LABEL}>Critics</span>
          <ScoreBadge score={show.compositeScore} size="md" reviewCount={show.reviewCount} status={show.status} />
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className={LABEL}>Audience</span>
          <AudienceBox grade={show.audienceGrade} size="md" />
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className={LABEL}>Awards</span>
          <AwardScoreBadge
            score={show.awardsScore ?? 0}
            badge={badgeFromScore(show.awardsScore)}
            inProgress={!ceremonyDate || new Date() < new Date(`${ceremonyDate}T12:00:00Z`)}
            size="md"
          />
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

      {/* Performer name (link to cast page) + show name + history */}
      <div className="flex-1 min-w-0">
        {actorUrl ? (
          <Link href={actorUrl} className="text-sm font-bold text-white hover:text-brand transition-colors block truncate">
            {show.nomineePersonName}
          </Link>
        ) : (
          <p className="text-sm font-bold text-white truncate">{show.nomineePersonName}</p>
        )}
        <Link href={`/show/${show.slug}`} className="text-xs text-gray-400 hover:text-gray-300 transition-colors block truncate mt-0.5">
          {show.title}
        </Link>
        <span className="text-[10px] text-gray-600">{historyLabel}</span>
      </div>

      {/* Gold Derby + Audience + Critic — consistent right-side layout */}
      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
        {/* Gold Derby */}
        <div className="hidden sm:flex flex-col items-center gap-0.5 w-16">
          <span className={LABEL}>Gold Derby</span>
          <span className="text-sm font-bold text-white">
            {show.gdOdds != null ? `${Math.round(show.gdOdds * 100)}%` : '—'}
          </span>
        </div>

        {/* Audience */}
        <div className="flex flex-col items-center gap-0.5">
          <span className={LABEL}>Audience</span>
          <AudienceBox grade={show.audienceGrade} size="sm" />
        </div>

        {/* Critic */}
        <div className="flex flex-col items-center gap-0.5">
          <span className={LABEL}>Critics</span>
          <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
        </div>
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
      </div>

      {/* Gold Derby + Audience + Critic */}
      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
        <div className="hidden sm:flex flex-col items-center gap-0.5 w-16">
          <span className={LABEL}>Gold Derby</span>
          <span className="text-sm font-bold text-white">
            {show.gdOdds != null ? `${Math.round(show.gdOdds * 100)}%` : '—'}
          </span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className={LABEL}>Audience</span>
          <AudienceBox grade={show.audienceGrade} size="sm" />
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className={LABEL}>Critics</span>
          <ScoreBadge score={show.compositeScore} size="sm" reviewCount={show.reviewCount} status={show.status} />
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
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">
              {season.ceremonyYear} Tony Nominees
            </h1>
            <p className="text-gray-400 mt-1 text-sm">
              {totalCategories} categories &middot; critic scores, audience grades, and win odds
            </p>
          </div>
          {ceremonyDate && (
            <span className="flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full bg-brand/10 text-brand border border-brand/20">
              Ceremony {formatCeremonyDate(ceremonyDate)}
            </span>
          )}
        </div>

        {/* Category sections */}
        {categories.map(cat => (
          <CategorySection key={cat.key} category={cat} />
        ))}

        {/* Legend */}
        <p className="mt-8 text-xs text-gray-600 text-center">
          Gold Derby win odds sourced from GoldDerby crowd predictions
        </p>
      </div>
    </>
  );
}
