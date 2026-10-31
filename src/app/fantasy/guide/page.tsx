import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { fantasySocial } from '@/config/fantasy-social';
import { getFantasyShowsSorted, getFantasyConfig } from '@/lib/data-fantasy';
import { ELIGIBILITY_MARKERS, isShowOpenForDrafter, isDraftOpen, isDraftClosed, earnsBoxOffice, nyDate, scoringFromDate, hasLateEntry, DRAFT_OPENS, SCORING_START, type FantasyShow } from '@/config/fantasy';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreLabel, getScoreColor, getScoreBgColor } from '@/config/score-buckets';
import FantasyOwnershipTag from '@/components/fantasy/FantasyOwnershipTag';

// Regenerated every 15 minutes: the draft-window lines and "already open"
// lists change at midnight ET, and waiting for the next deploy (up to 6h)
// left them stale on draft day (BRO-5548 audit). The data is bundled JSON,
// so a regeneration needs nothing beyond the build.
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'Fantasy Draft Guide',
  alternates: { canonical: `${BASE_URL}/fantasy/guide` },
  description: 'Every draftable show with its price, opening date and eligibility for the Broadway Fantasy League draft.',
  ...fantasySocial('Draft Guide | Broadway Fantasy League', '/fantasy/guide', 'Every draftable show with its price and opening date for the Broadway Fantasy League.'),
};

const PREMIUM_MIN = 20;
const MID_MIN = 12;

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function ScorePill({ score: rawScore }: { score: number }) {
  // Tier from the rounded score, so the colour matches the number shown.
  const score = Math.round(rawScore);
  const label = getScoreLabel(score); // display label ('Mixed' for 55-64); getCriticLabel is the data/wire key
  // Same tier colours as every other score on the site (score-buckets).
  const colorClass = `${getScoreBgColor(score)} ${getScoreColor(score)}`;

  return (
    <span className={`text-sm px-2 py-0.5 rounded-full ${colorClass}`}>
      {score} &middot; {label}
    </span>
  );
}

function ShowCard({ show, variant = 'default' }: { show: { id: string } & FantasyShow; variant?: 'default' | 'muted' }) {
  // "now" is the last regeneration (refreshed in the background every 15 minutes, see revalidate).
  const locked = isShowOpenForDrafter(show);
  // Locked for everyone can also mean "opens in the days before the draft".
  const opened = !!show.openingDate && show.openingDate <= nyDate(new Date().toISOString());
  return (
    <div className={`flex items-start gap-3 rounded-lg p-3 transition-colors ${
      variant === 'muted' ? 'bg-surface-raised/30 hover:bg-surface-raised/50' : 'bg-surface-raised/50 hover:bg-surface-raised/80'
    }`}>
      <div className="w-14 text-center shrink-0 pt-1 flex flex-col items-center">
        <span className="text-xl font-bold text-emerald-400">${show.price}</span>
        <FantasyOwnershipTag showId={show.id} className="text-xs leading-tight mt-0.5" />
      </div>
      {show.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-10 h-10 rounded object-cover shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-white">{show.title}</span>
          {show.type === 'musical' && (
            <span className="text-xs bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">Musical</span>
          )}
          {show.isRevival && (
            <span className="text-xs bg-surface-overlay text-gray-300 px-1.5 py-0.5 rounded">Revival</span>
          )}
          {show.category === 'off-broadway' && (
            <span className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">OB</span>
          )}
          {show.status === 'closed' && (
            <span className="text-xs bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded">Closed</span>
          )}
          {locked && show.status !== 'closed' && (
            <span className="text-xs border border-score-tepid/40 text-score-tepid px-1.5 py-0.5 rounded">{ELIGIBILITY_MARKERS.criticScoreLocked} {opened ? 'Already open' : 'Opens before the draft'}{earnsBoxOffice(show, scoringFromDate(new Date().toISOString())) ? '' : ': awards only'}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap text-sm text-gray-300">
          {show.openingDate && <span>{opened ? 'Opened' : 'Opens'} {shortDate(show.openingDate)}</span>}
          {show.closingDate && <span>&middot; closes {shortDate(show.closingDate)}</span>}
          {show.criticScore != null && <ScorePill score={show.criticScore} />}
          {show.audienceGrade && (
            <span>Audience: {show.audienceGrade}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TierSection({ title, subtitle, description, shows }: {
  title: string; subtitle: string; description?: string;
  shows: Array<{ id: string } & FantasyShow>;
}) {
  if (shows.length === 0) return null;
  return (
    <section className="mb-8">
      <div className={`flex items-baseline gap-2 ${description ? 'mb-1' : 'mb-3'}`}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-brand font-medium">{subtitle}</span>
        <span className="text-sm text-fg-muted font-normal">({shows.length})</span>
      </div>
      {description && <p className="text-sm text-gray-400 mb-3">{description}</p>}
      <div className="space-y-2">
        {shows.map(show => <ShowCard key={show.id} show={show} />)}
      </div>
    </section>
  );
}

export default function FantasyGuidePage() {
  const allShows = getFantasyShowsSorted();
  const config = getFantasyConfig();

  const bwShows = allShows.filter(s => s.category === 'broadway');
  const obShows = allShows.filter(s => s.category === 'off-broadway');

  // Group BW shows by price tier
  const premiumBW = bwShows.filter(s => s.price >= PREMIUM_MIN);
  const midBW = bwShows.filter(s => s.price >= MID_MIN && s.price < PREMIUM_MIN);
  const valueBW = bwShows.filter(s => s.price < MID_MIN);

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Draft Guide</h1>
          <p className="text-gray-300 mt-1">
            {allShows.length} draftable shows &middot; ${config._meta.budget} budget &middot; up to {config._meta.teamSize} picks
          </p>
        </div>

        {/* Legend */}
        <div className="bg-surface-raised/50 rounded-xl p-4 mb-8 text-base text-gray-300 space-y-2">
          {!isDraftOpen() && !isDraftClosed() && (
            <p className="text-brand">Prices are provisional until the draft opens on {shortDate(DRAFT_OPENS)}, then fixed for the season.</p>
          )}
          <p><span className="text-score-tepid">{ELIGIBILITY_MARKERS.criticScoreLocked} Already open</span> = reviews are public, so it earns box office (Broadway only) and awards points only (awards only if it closes before {hasLateEntry() ? 'your first box office week' : <>box office starts on {shortDate(SCORING_START)}</>}). <span className="text-purple-400">OB</span> = Off-Broadway (no box office, no Tony eligibility).</p>
          <details className="text-gray-400">
            <summary className="cursor-pointer text-gray-300 py-2">More on scoring</summary>
            <p className="mt-2">Shows that open after you draft earn critic and audience points for you. Audience points need the show&apos;s audience grade to be still unpublished when you draft (grades can appear in previews). Scores shown here may still change.</p>
          </details>
        </div>

        <TierSection title="Premium Broadway" subtitle={`$${PREMIUM_MIN}+`} shows={premiumBW} />

        <TierSection title="Mid-Range Broadway" subtitle={`$${MID_MIN}–${PREMIUM_MIN - 1}`} shows={midBW} />

        <TierSection title="Value Broadway" subtitle={`Under $${MID_MIN}`} shows={valueBW} />

        <TierSection
          title="Off-Broadway"
          subtitle={obShows.length ? `$${Math.min(...obShows.map(s => s.price))}–${Math.max(...obShows.map(s => s.price))}` : ''}
          description="No box office. Not Tony-eligible. Earn CriticScore, AudienceGrade, and Drama Desk, Outer Critics, Drama League and Lortel awards."
          shows={obShows}
        />

        {/* CTA */}
        <div className="text-center">
          <a
            href="/fantasy/draft"
            className="inline-block px-8 py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors"
          >
            Start Your Draft
          </a>
        </div>
      </div>
    </div>
  );
}
