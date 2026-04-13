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
    images: [{ url: 'https://broadwayscorecard.com/og/fantasy.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Fantasy League',
    description: 'Draft 8 shows. $100 budget. Win on Tony night.',
    images: ['https://broadwayscorecard.com/og/fantasy.png'],
  },
};

export default function FantasyLandingPage() {
  const info = getFantasySeasonInfo();

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-12 sm:pt-20 pb-12 text-center">
        {/* BFL Shield Logo */}
        <div className="mb-5 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/fantasy/bfl-logo.png"
            alt="BFL"
            width={600}
            height={387}
            className="w-[140px] sm:w-[180px] h-auto"
          />
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold mb-2">
          <span className="text-white">Broadway</span>{' '}
          <span className="text-gradient">Fantasy League</span>
        </h1>
        <p className="text-lg sm:text-xl text-zinc-400 max-w-xl mx-auto mb-4">
          Draft {info.teamSize} shows. ${info.budget} budget.
          Earn points from critics, audiences, box office, and the Tony Awards.
        </p>
        <p className="text-sm text-brand font-semibold mb-8">
          Winner gets a $500 TodayTix voucher
        </p>
        <a
          href="/fantasy/draft"
          className="inline-block px-10 py-4 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors text-lg"
        >
          Draft Your Team
        </a>
        <div className="mt-4">
          <a
            href="/fantasy/leaderboard"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            View Leaderboard &rarr;
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
              A hit musical grossing $1M/week earns about 3 pts per week.
              Points accumulate every week through Tony Awards night.
            </p>
            <p className="text-xs text-zinc-600 mt-2">
              Broadway shows only. Off-Broadway shows don&apos;t report grosses.
            </p>
          </div>

          {/* Awards */}
          <div className="bg-zinc-800/50 rounded-xl p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="text-brand">🏆</span> Awards
            </h3>
            <p className="text-xs text-zinc-500 mb-2">Tony Awards (biggest), Drama Desk, Outer Critics Circle, Drama League</p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Tony Best Musical / Play</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyBestMusical} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Tony Win</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyWin} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Tony Nomination</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.tonyNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Drama Desk Win / Nom</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.dramaDeskWin} / {AWARDS_POINTS.dramaDeskNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Outer Critics Win / Nom</span>
                <span className="font-mono text-zinc-300">{AWARDS_POINTS.outerCriticsWin} / {AWARDS_POINTS.outerCriticsNom} pts</span>
              </div>
            </div>
            <p className="text-xs text-zinc-600 mt-2">
              Scoring events across 6 weeks from mid-May through Tony night in June.
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
              q: 'What does the winner get?',
              a: 'A $500 TodayTix voucher. Highest total points on Tony night wins.',
            },
            {
              q: 'Do I need an account?',
              a: 'No. Just enter your email. One entry per email per season.',
            },
            {
              q: 'Can I change my picks after submitting?',
              a: 'Yes — re-submit with the same email before the draft deadline. Your new picks replace the old ones.',
            },
            {
              q: 'What about closed shows?',
              a: 'Shows that have already closed stop earning box office points, but they can still earn Tony nominations and wins. Some of the best Tony contenders closed early.',
            },
            {
              q: 'What about Off-Broadway shows?',
              a: 'Priced $3-$8. They earn CriticScore and AudienceGrade points, plus Drama Desk and Outer Critics Circle awards. No box office and no Tony nominations.',
            },
            {
              q: 'What are leagues?',
              a: 'Optional. Type the same league name as your friends on the draft form to create a private group. You can still see the overall leaderboard.',
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
        <a
          href="/fantasy/draft"
          className="inline-block px-10 py-4 bg-brand text-white font-semibold rounded-lg hover:bg-brand-hover transition-colors text-lg"
        >
          Draft Your Team
        </a>
        <div className="mt-4">
          <a
            href="/fantasy/guide"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Read the Draft Guide &rarr;
          </a>
        </div>
      </section>
    </div>
  );
}
