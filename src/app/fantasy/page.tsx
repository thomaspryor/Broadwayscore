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
    <div className="min-h-screen bg-surface text-white">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-12 sm:pt-20 pb-12 text-center">
        {/* BFL Shield Logo — extra padding prevents crown clip on mobile */}
        <div className="mb-5 flex justify-center pt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/fantasy/bfl-logo.png"
            alt="Broadway Fantasy League"
            width={600}
            height={387}
            className="w-[160px] sm:w-[200px] h-auto drop-shadow-[0_0_20px_rgba(212,165,116,0.3)]"
          />
        </div>
        <h1 className="text-4xl sm:text-5xl font-black mb-3 tracking-tight">
          <span className="text-white">Broadway</span>{' '}
          <span className="text-gradient">Fantasy League</span>
        </h1>
        <p className="text-lg sm:text-xl text-gray-300 max-w-xl mx-auto mb-3">
          Draft {info.teamSize} shows. ${info.budget} budget.
          Earn points from critics, audiences, box office, and the Tony Awards.
        </p>
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 bg-brand/10 border border-brand/20 rounded-full px-4 py-1.5">
            <span className="text-brand text-sm font-bold">Winner gets $500 to spend on TodayTix</span>
          </span>
        </div>
        <div className="mb-3">
          <a
            href="/fantasy/draft"
            className="inline-block px-10 py-4 bg-brand text-white font-bold rounded-xl hover:bg-brand-hover transition-all text-lg shadow-lg shadow-brand/20 hover:shadow-brand/40 hover:-translate-y-0.5"
          >
            Draft Your Team
          </a>
        </div>
        <div>
          <a
            href="/fantasy/leaderboard"
            className="text-gray-400 font-medium hover:text-white transition-colors text-sm"
          >
            View Leaderboard &rarr;
          </a>
        </div>
      </section>

      {/* How It Works */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">How It Works</h2>
        <div className="grid sm:grid-cols-3 gap-6">
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">1</div>
            <h3 className="font-semibold mb-2 text-white">Draft</h3>
            <p className="text-sm text-gray-400">
              Pick {info.teamSize} shows from {info.totalShows} options.
              Stay within your ${info.budget} budget.
              No account needed.
            </p>
          </div>
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">2</div>
            <h3 className="font-semibold mb-2 text-white">Score</h3>
            <p className="text-sm text-gray-400">
              Points accumulate from four pillars:
              critics, audiences, box office, and awards.
            </p>
          </div>
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">3</div>
            <h3 className="font-semibold mb-2 text-white">Win</h3>
            <p className="text-sm text-gray-400">
              Season runs through Tony Awards night.
              Most points wins. Check the leaderboard weekly.
            </p>
          </div>
        </div>
      </section>

      {/* Scoring */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">Four Ways to Score</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {/* CriticScore */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-yellow-400/15 text-yellow-400 text-sm">★</span> CriticScore
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(CRITIC_SCORE_POINTS).map(([tier, pts]) => (
                <div key={tier} className="flex justify-between">
                  <span className="text-gray-400">{tier}</span>
                  <span className="font-mono text-gray-300">{pts} pts</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-3">
              Based on Broadway Scorecard&apos;s critic composite score.
              Shows that opened before the season start don&apos;t earn critic points.
            </p>
          </div>

          {/* AudienceGrade */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-400/15 text-emerald-400 text-sm">♥</span> Audience Grade
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(AUDIENCE_GRADE_POINTS)
                .filter(([, pts]) => pts > 0)
                .map(([grade, pts]) => (
                  <div key={grade} className="flex justify-between">
                    <span className="text-gray-400">{grade}</span>
                    <span className="font-mono text-gray-300">{pts} pts</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Box Office */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-green-400/15 text-green-400 text-sm font-bold">$</span> Box Office
            </h3>
            <p className="text-sm text-gray-400">
              A hit musical grossing $1M/week earns about 3 pts per week.
              Points accumulate every week through Tony Awards night.
            </p>
            <p className="text-xs text-gray-600 mt-2">
              Broadway shows only. Off-Broadway shows don&apos;t report grosses.
            </p>
          </div>

          {/* Awards */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-brand/15 text-brand text-sm">🏆</span> Awards
            </h3>
            <p className="text-xs text-gray-500 mb-2">7 ceremonies: Tonys, Drama Desk, Outer Critics, Drama League, NYDCC, Lortel, Obie</p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Tony Best Musical / Play</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.tonyBestMusical} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Tony Win / Nom</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.tonyWin} / {AWARDS_POINTS.tonyNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Drama Desk Win / Nom</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.dramaDeskWin} / {AWARDS_POINTS.dramaDeskNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Outer Critics Win / Nom</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.outerCriticsWin} / {AWARDS_POINTS.outerCriticsNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">NYDCC Win</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.nydccWin} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Lortel Win / Nom</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.lortelWin} / {AWARDS_POINTS.lortelNom} pts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Obie Award</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.obieAward} pts</span>
              </div>
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Scoring events across 6 weeks from mid-May through Tony night in June.
            </p>
          </div>
        </div>
      </section>

      {/* Season Info */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">Season Details</h2>
        <div className="bg-surface-raised/50 rounded-xl p-6">
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Season</span>
              <p className="text-white font-medium">{info.season}</p>
            </div>
            <div>
              <span className="text-gray-500">Budget</span>
              <p className="text-white font-medium">${info.budget} for {info.teamSize} shows</p>
            </div>
            <div>
              <span className="text-gray-500">Draftable Shows</span>
              <p className="text-white font-medium">{info.broadwayShows} Broadway + {info.offBroadwayShows} Off-Broadway</p>
            </div>
            <div>
              <span className="text-gray-500">Scoring Period</span>
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
              a: '$500 to spend on TodayTix. Highest total points on Tony Awards night wins.',
            },
            {
              q: 'Is it free?',
              a: 'Yes, completely free. No account needed — just enter your email to draft.',
            },
            {
              q: 'When is the draft deadline?',
              a: 'You can draft anytime during the season. The earlier you draft, the more weeks of box office points your shows accumulate.',
            },
            {
              q: 'Can I change my picks after submitting?',
              a: 'No. Picks are final once submitted — one entry per email, locked in for the season. Draft carefully.',
            },
            {
              q: 'How do show prices work?',
              a: 'Each show has a price ($5-$35) based on how likely it is to score well. Buzzy new musicals cost more. You have $100 to fill 8 slots, so you need a mix of big bets and value picks.',
            },
            {
              q: 'What\'s the best strategy?',
              a: 'Awards are worth the most points, so pick shows likely to earn Tony nominations. But don\'t ignore box office — a hit musical earning $1M/week accumulates points every week. A mix of a few premium contenders and some value sleepers usually beats going all-in on favorites.',
            },
            {
              q: 'What about shows that close early?',
              a: 'They stop earning box office points, but they can still earn Tony nominations and wins. Some of the best Tony contenders closed early — a $6 show that earns a Best Musical nom is a massive value pick.',
            },
            {
              q: 'What about Off-Broadway shows?',
              a: 'Priced $5-$9. They earn CriticScore and AudienceGrade points, plus Drama Desk, Outer Critics Circle, Lortel, and Obie awards. No box office and no Tony nominations.',
            },
            {
              q: 'When do scores update?',
              a: 'Weekly. Box office data updates every Tuesday, and scores are recomputed every Wednesday. You\'ll get a weekly email with the latest standings.',
            },
            {
              q: 'What are leagues?',
              a: 'Optional. Type the same league name as your friends on the draft form to create a private group. You\'ll see your league standings alongside the overall leaderboard.',
            },
            {
              q: 'How are ties broken?',
              a: 'Three tiebreaker questions on the draft form: how many nominations the most-nominated show will receive, which show will win Best Musical, and the total number of Tony nominations. Closest answers win.',
            },
            {
              q: 'Where do the scores come from?',
              a: 'CriticScore is Broadway Scorecard\'s composite of professional critic reviews. AudienceGrade comes from audience review platforms. Box office is weekly Broadway grosses. Awards are official nominations and wins from 7 major ceremonies.',
            },
          ].map(({ q, a }) => (
            <div key={q} className="bg-surface-raised/30 rounded-xl p-4">
              <h3 className="font-medium text-white mb-1">{q}</h3>
              <p className="text-sm text-gray-400">{a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-gray-400 mb-4">Ready to play?</p>
        <div className="mb-3">
          <a
            href="/fantasy/draft"
            className="inline-block px-10 py-4 bg-brand text-white font-bold rounded-xl hover:bg-brand-hover transition-all text-lg shadow-lg shadow-brand/20 hover:shadow-brand/40 hover:-translate-y-0.5"
          >
            Draft Your Team
          </a>
        </div>
        <div>
          <a
            href="/fantasy/guide"
            className="text-gray-400 font-medium hover:text-white transition-colors text-sm"
          >
            Read the Draft Guide &rarr;
          </a>
        </div>
      </section>
    </div>
  );
}
