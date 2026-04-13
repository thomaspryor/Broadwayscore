import { Metadata } from 'next';
import { getFantasyShowsSorted, getFantasyConfig, getShowScore } from '@/lib/data-fantasy';
import { getCriticLabel, ELIGIBILITY_MARKERS, type FantasyShow } from '@/config/fantasy';
import { getOptimizedImageUrl } from '@/lib/images';

export const metadata: Metadata = {
  title: 'Fantasy Draft Guide',
  description: 'Every draftable show with prices, scores, and eligibility. Your cheat sheet for the Broadway Fantasy League draft.',
};

function ScorePill({ score }: { score: number }) {
  const label = getCriticLabel(score);
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
  const score = getShowScore(show.id);
  return (
    <div className={`flex items-center gap-3 rounded-lg p-3 transition-colors ${
      variant === 'muted' ? 'bg-zinc-800/30 hover:bg-zinc-800/50' : 'bg-zinc-800/50 hover:bg-zinc-800/80'
    }`}>
      <div className="w-12 text-center shrink-0">
        <span className="text-lg font-bold text-emerald-400">${show.price}</span>
      </div>
      {show.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-white">{show.title}</span>
          {show.type === 'musical' && (
            <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">Musical</span>
          )}
          {show.category === 'off-broadway' && (
            <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">OB</span>
          )}
          {show.status === 'closed' && (
            <span className="text-[10px] bg-zinc-600/30 text-zinc-400 px-1.5 py-0.5 rounded">Closed</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {show.criticScore && <ScorePill score={show.criticScore} />}
          {show.audienceGrade && (
            <span className="text-xs text-zinc-400">Audience: {show.audienceGrade}</span>
          )}
        </div>
      </div>
      {score && score.totalPoints > 0 && (
        <div className="text-right shrink-0">
          <span className="text-sm font-bold text-brand">{score.totalPoints.toFixed(1)}</span>
          <span className="text-xs text-zinc-500 ml-1">pts</span>
        </div>
      )}
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
        <span className="text-sm text-zinc-500 font-normal">({shows.length})</span>
      </div>
      <p className="text-xs text-zinc-500 mb-3">{description}</p>
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
  const premiumBW = bwShows.filter(s => s.price >= 17);
  const midBW = bwShows.filter(s => s.price >= 12 && s.price < 17);
  const valueBW = bwShows.filter(s => s.price < 12);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-8">
          <a href="/fantasy" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            &larr; Fantasy League
          </a>
          <h1 className="text-2xl sm:text-3xl font-bold mt-2">Draft Guide</h1>
          <p className="text-zinc-400 mt-1">
            {allShows.length} draftable shows &middot; ${config._meta.budget} budget &middot; {config._meta.teamSize} picks
          </p>
        </div>

        {/* Legend */}
        <div className="bg-zinc-800/50 rounded-xl p-4 mb-8 text-sm text-zinc-400 space-y-1">
          <p><span className="text-purple-400">{ELIGIBILITY_MARKERS.offBroadway}</span> = Off-Broadway (no box office, no Tony eligibility)</p>
          <p className="text-zinc-500">Shows with critic scores display them for your research. Scores may still change.</p>
        </div>

        {/* Premium Broadway ($17+) */}
        <TierSection title="Premium Broadway" subtitle="$17+" description="Tony contenders with box office upside" shows={premiumBW} />

        {/* Mid-Range Broadway ($12-16) */}
        <TierSection title="Mid-Range Broadway" subtitle="$12-16" description="Strong reviews or steady grosses" shows={midBW} />

        {/* Value Broadway (under $12) */}
        <TierSection title="Value Broadway" subtitle="Under $12" description="Closed shows or long shots — Tony noms could pay off big" shows={valueBW} />

        {/* Off-Broadway */}
        <TierSection
          title="Off-Broadway"
          subtitle={ELIGIBILITY_MARKERS.offBroadway}
          description="No box office. Not Tony-eligible. Earn CriticScore, AudienceGrade, and Drama Desk / Outer Critics awards."
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
