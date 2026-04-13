import { Metadata } from 'next';
import { getFantasySeasonInfo } from '@/lib/data-fantasy';
import {
  CRITIC_SCORE_POINTS,
  AUDIENCE_GRADE_POINTS,
  BOX_OFFICE_POINTS_PER_100K,
  AWARDS_POINTS,
} from '@/config/fantasy';

export const metadata: Metadata = {
  title: 'Broadway Fantasy League',
  description: 'Draft 8 Broadway shows within a $100 budget. Earn points from critics, audiences, box office, and Tony Awards. Free to play, no account needed.',
  openGraph: {
    title: 'Broadway Fantasy League',
    description: 'Draft 8 shows. $100 budget. Critics + box office + Tonys. Who picks the best season?',
    url: 'https://broadwayscorecard.com/fantasy',
  },
};

export default function FantasyLandingPage() {
  const info = getFantasySeasonInfo();

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-12 sm:pt-20 pb-12 text-center">
        {/* BFL Shield Logo */}
        <div className="mb-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/fantasy/bfl-logo.svg"
            alt="Broadway Fantasy League"
            width={140}
            height={182}
            className="sm:w-[180px] sm:h-auto"
          />
        </div>
        <h1 className="sr-only">Broadway Fantasy League</h1>
        <p className="text-lg sm:text-xl text-zinc-400 max-w-xl mx-auto mb-8">
          Draft {info.teamSize} shows. ${info.budget} budget.
          Earn points from critics, audiences, box office, and the Tony Awards.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="/fantasy/draft"
            className="px-8 py-3.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors text-lg"
          >
            Draft Your Team
          </a>
          <a
            href="/fantasy/leaderboard"
            className="px-8 py-3.5 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 transition-colors text-lg"
          >
            View Leaderboard
          </a>
        </div>
      </section>

      {/* How It Works */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">How It Works</h2>
        <div className="grid sm:grid-cols-3 gap-6">
          <div className="bg-zinc-800/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-3">1</div>
            <h3 className="font-semibold mb-2">Draft</h3>
            <p className="text-sm text-zinc-400">
              Pick {info.teamSize} shows from {info.totalShows} options.
              Stay within your ${info.budget} budget.
              One entry per email — no account needed.
            </p>
          </div>
          <div className="bg-zinc-800/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-3">2</div>
            <h3 className="font-semibold mb-2">Score</h3>
            <p className="text-sm text-zinc-400">
              Points accumulate automatically from four pillars:
              critic reviews, audience grades, weekly box office, and award nominations & wins.
            </p>
          </div>
          <div className="bg-zinc-800/50 rounded-xl p-6 text-center">
            <div className="text-3xl mb-3">3</div>
            <h3 className="font-semibold mb-2">Win</h3>
            <p className="text-sm text-zinc-400">
              The season runs through Tony Awards night.
              Most points wins. Check the leaderboard weekly to track your ranking.
            </p>
          </div>
        </div>
      </section>

      {/* Scoring */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">Scoring</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {/* CriticScore */}
          <div className="bg-zinc-800/50 rounded-xl p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="text-yellow-400">★</span> CriticScore
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(CRITIC_SCORE_POINTS).map(([tier, pts]) => (
                <div key={tier} className="flex justify-between">
                  <span className="text-zinc-400">{tier}</span>
                  <span className="font-mono text-zinc-300">{pts} pts</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-600 mt-3">
              Based on Broadway Scorecard&apos;s critic composite score.
              Shows that opened before the season start don&apos;t earn critic points.
            </p>
          </div>

          {/* AudienceGrade */}
          <div className="bg-zinc-800/50 rounded-xl p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="text-emerald-400">♥</span> Audience Grade
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(AUDIENCE_GRADE_POINTS)
                .filter(([, pts]) => pts > 0)
                .map(([grade, pts]) => (
                  <div key={grade} className="flex justify-between">
                    <span className="text-zinc-400">{grade}</span>
                    <span className="font-mono text-zinc-300">{pts} pts</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Box Office */}
          <div className="bg-zinc-800/50 rounded-xl p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="text-green-400">$</span> Box Office
            </h3>
            <p className="text-sm text-zinc-400">
              {BOX_OFFICE_POINTS_PER_100K} points per $100K in weekly Broadway League grosses.
              Points accumulate every week through Tony Awards night.
            </p>
            <p className="text-xs text-zinc-600 mt-2">
              Broadway shows only. Off-Broadway shows don&apos;t report grosses.
            </p>
          </div>

          {/* Awards */}
          <div className="bg-zinc-800/50 rounded-xl p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="text-amber-400">🏆</span> Tony Awards
            </h3>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Best Musical / Best Play</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyBestMusical} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Other Tony Win</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyWin} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Tony Nomination</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyNom} pts</span>
              </div>
            </div>
            <p className="text-xs text-zinc-600 mt-2">
              Broadway shows only. Awards entered manually as ceremonies happen.
            </p>
          </div>
        </div>
      </section>

      {/* Season Info */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">Season Details</h2>
        <div className="bg-zinc-800/50 rounded-xl p-6">
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-zinc-500">Season</span>
              <p className="text-white font-medium">{info.season}</p>
            </div>
            <div>
              <span className="text-zinc-500">Budget</span>
              <p className="text-white font-medium">${info.budget} for {info.teamSize} shows</p>
            </div>
            <div>
              <span className="text-zinc-500">Draftable Shows</span>
              <p className="text-white font-medium">{info.broadwayShows} Broadway + {info.offBroadwayShows} Off-Broadway</p>
            </div>
            <div>
              <span className="text-zinc-500">Scoring Period</span>
              <p className="text-white font-medium">{info.scoringStart} to {info.scoringEnd}</p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">FAQ</h2>
        <div className="space-y-4">
          {[
            {
              q: 'Do I need an account?',
              a: 'No. Just enter your email. One entry per email per season.',
            },
            {
              q: 'Can I change my picks after submitting?',
              a: 'Yes — re-submit with the same email before the draft deadline. Your new picks replace the old ones.',
            },
            {
              q: 'What are leagues?',
              a: 'Optional. Type the same league name as your friends on the draft form to create a private group. You can still see the overall leaderboard.',
            },
            {
              q: 'What about Off-Broadway shows?',
              a: 'Priced $3-$8. They can earn CriticScore and AudienceGrade points, but no box office (they don\'t report grosses) and no Tony nominations.',
            },
          ].map(({ q, a }) => (
            <div key={q} className="bg-zinc-800/30 rounded-xl p-4">
              <h3 className="font-medium text-white mb-1">{q}</h3>
              <p className="text-sm text-zinc-400">{a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-3xl mx-auto px-4 py-12 text-center">
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="/fantasy/draft"
            className="px-8 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
          >
            Draft Your Team
          </a>
          <a
            href="/fantasy/guide"
            className="px-8 py-3 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 transition-colors"
          >
            Read the Draft Guide
          </a>
        </div>
      </section>
    </div>
  );
}
