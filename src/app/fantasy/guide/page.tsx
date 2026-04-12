import { Metadata } from 'next';
import { getFantasyShowsSorted, getFantasyConfig, getShowScore } from '@/lib/data-fantasy';
import { getCriticLabel, ELIGIBILITY_MARKERS } from '@/config/fantasy';

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

export default function FantasyGuidePage() {
  const allShows = getFantasyShowsSorted();
  const config = getFantasyConfig();

  const bwShows = allShows.filter(s => s.category === 'broadway');
  const obShows = allShows.filter(s => s.category === 'off-broadway');

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

        {/* Broadway Shows */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            Broadway
            <span className="text-sm text-zinc-500 font-normal">({bwShows.length} shows)</span>
          </h2>
          <div className="space-y-2">
            {bwShows.map(show => {
              const score = getShowScore(show.id);
              return (
                <div
                  key={show.id}
                  className="flex items-center gap-3 bg-zinc-800/50 rounded-lg p-3 hover:bg-zinc-800/80 transition-colors"
                >
                  {/* Price */}
                  <div className="w-12 text-center">
                    <span className="text-lg font-bold text-emerald-400">${show.price}</span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white">{show.title}</span>
                      {show.type === 'musical' && (
                        <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">Musical</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {show.criticScore && <ScorePill score={show.criticScore} />}
                      {show.audienceGrade && (
                        <span className="text-xs text-zinc-400">Audience: {show.audienceGrade}</span>
                      )}
                      <span className="text-xs text-zinc-600">{show.status}</span>
                      {show.openingDate && (
                        <span className="text-xs text-zinc-600">{show.openingDate}</span>
                      )}
                    </div>
                  </div>

                  {/* Fantasy points so far */}
                  {score && score.totalPoints > 0 && (
                    <div className="text-right shrink-0">
                      <span className="text-sm font-bold text-amber-400">{score.totalPoints.toFixed(1)}</span>
                      <span className="text-xs text-zinc-500 ml-1">pts</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Off-Broadway Shows */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            Off-Broadway
            <span className="text-sm text-zinc-500 font-normal">({obShows.length} shows)</span>
            <span className="text-purple-400 text-sm">{ELIGIBILITY_MARKERS.offBroadway}</span>
          </h2>
          <p className="text-xs text-zinc-500 mb-3">
            No box office points. Not Tony-eligible. Can earn CriticScore, AudienceGrade, and non-Tony awards.
          </p>
          <div className="space-y-2">
            {obShows.map(show => {
              const score = getShowScore(show.id);
              return (
                <div
                  key={show.id}
                  className="flex items-center gap-3 bg-zinc-800/30 rounded-lg p-3 hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="w-12 text-center">
                    <span className="text-lg font-bold text-emerald-400">${show.price}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white">{show.title}</span>
                      {show.type === 'musical' && (
                        <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded">Musical</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {show.criticScore && <ScorePill score={show.criticScore} />}
                      <span className="text-xs text-zinc-600">{show.status}</span>
                    </div>
                  </div>
                  {score && score.totalPoints > 0 && (
                    <div className="text-right shrink-0">
                      <span className="text-sm font-bold text-amber-400">{score.totalPoints.toFixed(1)}</span>
                      <span className="text-xs text-zinc-500 ml-1">pts</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* CTA */}
        <div className="text-center">
          <a
            href="/fantasy/draft"
            className="inline-block px-8 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
          >
            Start Your Draft
          </a>
        </div>
      </div>
    </div>
  );
}
