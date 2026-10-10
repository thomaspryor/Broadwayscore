import { Metadata } from 'next';
import { getFantasyShowsSorted, getFantasyConfig } from '@/lib/data-fantasy';
import { ELIGIBILITY_MARKERS, type FantasyShow } from '@/config/fantasy';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreLabel } from '@/config/score-buckets';

export const metadata: Metadata = {
  title: 'Fantasy Draft Guide',
  description: 'Every draftable show with prices, the reasoning behind each price, scores, and eligibility. Your cheat sheet for the Broadway Fantasy League draft.',
};

const PREMIUM_MIN = 20;
const MID_MIN = 12;

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function ScorePill({ score }: { score: number }) {
  const label = getScoreLabel(score); // display label ('Mixed' for 55-64); getCriticLabel is the data/wire key
  const colorClass =
    score >= 83 ? 'bg-yellow-500/20 text-yellow-300' :
    score >= 75 ? 'bg-emerald-500/20 text-emerald-300' :
    score >= 65 ? 'bg-teal-500/20 text-teal-300' :
    score >= 55 ? 'bg-orange-500/20 text-orange-300' :
    'bg-red-500/20 text-red-300';

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colorClass}`}>
      {Math.round(score)} &middot; {label}
    </span>
  );
}

function ShowCard({ show, variant = 'default' }: { show: { id: string } & FantasyShow; variant?: 'default' | 'muted' }) {
  const locked = !show.eligible.criticScore;
  return (
    <div className={`flex items-start gap-3 rounded-lg p-3 transition-colors ${
      variant === 'muted' ? 'bg-surface-raised/30 hover:bg-surface-raised/50' : 'bg-surface-raised/50 hover:bg-surface-raised/80'
    }`}>
      <div className="w-12 text-center shrink-0 pt-1">
        <span className="text-lg font-bold text-emerald-400">${show.price}</span>
      </div>
      {show.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-10 h-10 rounded object-cover shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-white">{show.title}</span>
          {show.type === 'musical' && (
            <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">Musical</span>
          )}
          {show.isRevival && (
            <span className="text-[10px] bg-surface-overlay text-gray-300 px-1.5 py-0.5 rounded">Revival</span>
          )}
          {show.category === 'off-broadway' && (
            <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">OB</span>
          )}
          {show.status === 'closed' && (
            <span className="text-[10px] bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded">Closed</span>
          )}
          {locked && show.status !== 'closed' && (
            <span className="text-[10px] bg-yellow-500/15 text-yellow-300 px-1.5 py-0.5 rounded">{ELIGIBILITY_MARKERS.criticScoreLocked} Already open</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-gray-400">
          {show.openingDate && <span>Opens {shortDate(show.openingDate)}</span>}
          {show.closingDate && <span>&middot; closes {shortDate(show.closingDate)}</span>}
          {show.criticScore != null && <ScorePill score={show.criticScore} />}
          {show.audienceGrade && (
            <span>Audience: {show.audienceGrade}</span>
          )}
        </div>
        {show.priceNote && (
          <p className="text-xs text-gray-500 mt-1.5 leading-snug">{show.priceNote}</p>
        )}
      </div>
    </div>
  );
}

function TierSection({ title, subtitle, description, shows }: {
  title: string; subtitle: string; description: string;
  shows: Array<{ id: string } & FantasyShow>;
}) {
  if (shows.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-brand font-medium">{subtitle}</span>
        <span className="text-sm text-gray-500 font-normal">({shows.length})</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">{description}</p>
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
          <a href="/fantasy" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Draft Guide</h1>
          <p className="text-gray-400 mt-1">
            {allShows.length} draftable shows &middot; ${config._meta.budget} budget &middot; up to {config._meta.teamSize} picks
          </p>
        </div>

        {/* Legend */}
        <div className="bg-surface-raised/50 rounded-xl p-4 mb-8 text-sm text-gray-400 space-y-1">
          <p>Prices reflect projected points: Tony prospects, box office outlook, weeks left to run, and known scores. The line under each show is the reasoning.</p>
          <p><span className="text-yellow-300">{ELIGIBILITY_MARKERS.criticScoreLocked} Already open</span> = reviews are public, so the show earns box office and awards points only.</p>
          <p><span className="text-purple-400">OB</span> = Off-Broadway (no box office, no Tony eligibility)</p>
          <p className="text-gray-500">Shows that open after you draft earn critic and audience points for you. Scores shown here may still change.</p>
        </div>

        <TierSection title="Premium Broadway" subtitle={`$${PREMIUM_MIN}+`} description="Tony frontrunners and the biggest box office" shows={premiumBW} />

        <TierSection title="Mid-Range Broadway" subtitle={`$${MID_MIN}–${PREMIUM_MIN - 1}`} description="Credible contenders, star vehicles and limited runs" shows={midBW} />

        <TierSection title="Value Broadway" subtitle={`Under $${MID_MIN}`} description="Long shots, special events and shows that already opened. A surprise nomination pays off big." shows={valueBW} />

        <TierSection
          title="Off-Broadway"
          subtitle={obShows.length ? `$${Math.min(...obShows.map(s => s.price))}–${Math.max(...obShows.map(s => s.price))}` : ''}
          description="No box office. Not Tony-eligible. Earn CriticScore, AudienceGrade, and Drama Desk, Outer Critics, Lortel and Obie awards."
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
