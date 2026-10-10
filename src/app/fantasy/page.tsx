import { Metadata } from 'next';
import { getFantasySeasonInfo, getFantasyShowsSorted } from '@/lib/data-fantasy';
import {
  CRITIC_SCORE_POINTS,
  AUDIENCE_GRADE_POINTS,
  BOX_OFFICE_POINTS_PER_100K,
  AWARDS_POINTS,
  PRIZE_DESCRIPTION,
  DRAFT_OPENS,
  FANTASY_TONY_WINDOW,
  draftDeadlineDate,
  getCriticLabel,
} from '@/config/fantasy';
import { SCORE_BUCKETS } from '@/config/score-buckets';

// Keyed by the points-table label (getCriticLabel), not the display label:
// the 55-64 bucket displays as "Mixed" but scores as "Skippable".
const CRITIC_TIER_RANGES: Record<string, string> = Object.fromEntries(
  SCORE_BUCKETS
    .filter((b) => b.id !== 'pending')
    .map((b) => [getCriticLabel(b.minScore), `${b.minScore}–${b.maxScore}`])
);

function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export const metadata: Metadata = {
  title: 'Broadway Fantasy League',
  description: 'Draft up to 8 Broadway shows on a $100 budget. Earn points from critics, audiences, box office, and the Tony Awards. Free to play, no account needed.',
  openGraph: {
    title: 'Broadway Fantasy League',
    description: 'Draft up to 8 shows. $100 budget. Critics + box office + Tonys. Who picks the best season?',
    url: 'https://broadwayscorecard.com/fantasy',
    images: [{ url: 'https://broadwayscorecard.com/og/fantasy.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Fantasy League',
    description: 'Draft up to 8 shows. $100 budget. Win on Tony night.',
    images: ['https://broadwayscorecard.com/og/fantasy.png'],
  },
};

export default function FantasyLandingPage() {
  const info = getFantasySeasonInfo();
  const shows = getFantasyShowsSorted();
  const alreadyOpen = shows.filter(s => !s.eligible.criticScore && s.status !== 'closed');
  const seasonLabel = FANTASY_TONY_WINDOW.label;
  const deadlineDate = draftDeadlineDate();
  const allPrices = shows.map(s => s.price);
  const obPrices = shows.filter(s => s.category === 'off-broadway').map(s => s.price);
  const priceRange = { min: Math.min(...allPrices), max: Math.max(...allPrices) };
  const obRange = obPrices.length ? { min: Math.min(...obPrices), max: Math.max(...obPrices) } : null;

  // Worked example for "Scoring in 30 seconds", computed from the live point
  // tables so the numbers can never drift from the rules.
  const exampleWeeks = 20;
  const exampleNoms = 6;
  const exampleCritic = CRITIC_SCORE_POINTS['Critical Gold'];
  const exampleAudience = AUDIENCE_GRADE_POINTS['A-'];
  const exampleBoxOffice = Math.round(exampleWeeks * 10 * BOX_OFFICE_POINTS_PER_100K);
  const exampleAwards = (exampleNoms - 1) * AWARDS_POINTS.tonyNom + AWARDS_POINTS.tonyWin + AWARDS_POINTS.tonyBestMusical;
  const example = {
    weeks: exampleWeeks,
    noms: exampleNoms,
    critic: exampleCritic,
    audience: exampleAudience,
    boxOffice: exampleBoxOffice,
    awards: exampleAwards,
    total: exampleCritic + exampleAudience + exampleBoxOffice + exampleAwards,
  };

  const calendar = [
    { date: DRAFT_OPENS, label: 'Draft opens' },
    { date: info.scoringStart, label: 'Scoring starts' },
    { date: info.earlyBirdCutoff ?? info.scoringStart, label: 'Early-bird cutoff: draft by this day and your box office counts from the season start' },
    { date: deadlineDate, label: 'Draft deadline (11:59pm ET)' },
    { date: FANTASY_TONY_WINDOW.end, label: 'Tony eligibility cutoff' },
    { date: info.scoringEnd, label: 'Tony Awards night (expected date): final standings' },
  ];

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
        <p className="text-xs font-semibold uppercase tracking-widest text-brand mb-3">{seasonLabel} season</p>
        <h1 className="text-4xl sm:text-5xl font-black mb-3 tracking-tight">
          <span className="text-white">Broadway</span>{' '}
          <span className="text-gradient">Fantasy League</span>
        </h1>
        <p className="text-lg sm:text-xl text-gray-300 max-w-xl mx-auto mb-3">
          Draft up to {info.teamSize} shows on a ${info.budget} budget.
          Earn points from critics, audiences, box office, and the Tony Awards.
        </p>
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 bg-brand/10 border border-brand/20 rounded-full px-4 py-1.5">
            <span className="text-brand text-sm font-bold">Winner gets {PRIZE_DESCRIPTION}</span>
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

      {/* Already open */}
      {alreadyOpen.length > 0 && (
        <section className="max-w-3xl mx-auto px-4 py-6">
          <div className="bg-surface-raised/50 rounded-xl p-6 border border-brand/20">
            <h2 className="text-lg font-bold mb-2">
              {alreadyOpen.length === 1 ? 'One show has' : `${alreadyOpen.length} shows have`} already opened
            </h2>
            <p className="text-sm text-gray-400 mb-3">
              {alreadyOpen.map(s => s.title).join(' and ')} opened before the draft, so their reviews are already public.
              They earn box office and awards points only, and their prices reflect that.
              The same rule applies to any show that opens before you draft: you can still pick it, but critic and audience points go only to players who drafted it before opening night.
            </p>
            <ul className="text-sm text-gray-300 space-y-2">
              {alreadyOpen.map(s => (
                <li key={s.id} className="flex items-start justify-between gap-4">
                  <span className="min-w-0">
                    <span className="block">{s.title}</span>
                    <span className="block text-xs text-gray-500">
                      {s.criticScore != null && <>CriticScore {Math.round(s.criticScore)}</>}
                      {s.criticScore != null && s.openingDate && ' · '}
                      {s.openingDate && <>opened {shortDate(s.openingDate)}</>}
                    </span>
                  </span>
                  <span className="font-mono text-emerald-400 shrink-0">${s.price}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* How It Works */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">How It Works</h2>
        <div className="grid sm:grid-cols-3 gap-6">
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">1</div>
            <h3 className="font-semibold mb-2 text-white">Draft</h3>
            <p className="text-sm text-gray-400">
              Pick up to {info.teamSize} of the {info.totalShows} draftable shows from this Tony season.
              Stay within your ${info.budget} budget.
              No account needed.
            </p>
          </div>
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">2</div>
            <h3 className="font-semibold mb-2 text-white">Score</h3>
            <p className="text-sm text-gray-400">
              Points accumulate from four pillars:
              critics, audiences, box office, and awards. Standings update every Wednesday.
            </p>
          </div>
          <div className="bg-surface-raised/50 rounded-xl p-6 text-center border border-white/5 hover:border-brand/20 transition-colors">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand/15 text-brand font-bold text-lg mb-3">3</div>
            <h3 className="font-semibold mb-2 text-white">Win</h3>
            <p className="text-sm text-gray-400">
              The season runs through Tony Awards night in June.
              Most points wins.
            </p>
          </div>
        </div>
      </section>

      {/* Worked example */}
      <section className="max-w-3xl mx-auto px-4 py-6">
        <div className="bg-surface-raised/30 rounded-xl p-6 border border-white/5">
          <h2 className="text-lg font-bold mb-2">Scoring in 30 seconds</h2>
          <p className="text-sm text-gray-400 mb-3">
            Say you draft a new musical before it opens. Here is how a great season adds up:
          </p>
          <ul className="text-sm text-gray-300 space-y-1.5">
            <li className="flex justify-between gap-4"><span>Opens to Critical Gold reviews</span><span className="font-mono text-gray-300 shrink-0">{example.critic} pts</span></li>
            <li className="flex justify-between gap-4"><span>Audiences give it an A-</span><span className="font-mono text-gray-300 shrink-0">{example.audience} pts</span></li>
            <li className="flex justify-between gap-4"><span>Grosses $1M a week for {example.weeks} weeks</span><span className="font-mono text-gray-300 shrink-0">{example.boxOffice} pts</span></li>
            <li className="flex justify-between gap-4"><span>{example.noms} Tony nominations, wins Best Musical</span><span className="font-mono text-gray-300 shrink-0">{example.awards} pts</span></li>
            <li className="flex justify-between gap-4 border-t border-white/10 pt-1.5 font-semibold text-white"><span>Season total from one pick</span><span className="font-mono shrink-0">{example.total} pts</span></li>
          </ul>
          <p className="text-xs text-gray-500 mt-3">
            A flop earns a few box office points and nothing else. That gap is the whole game.
          </p>
        </div>
      </section>

      {/* Scoring */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">Four Ways to Score</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {/* Awards — highest ceiling, listed first */}
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
                <span className="text-gray-400">Drama League Win / Nom</span>
                <span className="font-mono text-gray-300">{AWARDS_POINTS.dramaLeagueWin} / {AWARDS_POINTS.dramaLeagueNom} pts</span>
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
            <p className="text-xs text-gray-500 mt-2">
              Scoring events across six weeks from early May through Tony night in June. Awards count for every player, whenever you drafted.
            </p>
          </div>

          {/* Box Office */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-green-400/15 text-green-400 text-sm font-bold">$</span> Box Office
            </h3>
            <p className="text-sm text-gray-400">
              A hit musical grossing $1M a week earns about 3 points every week.
              Points accumulate from the week you draft through Tony Awards night.
              Draft by {shortDate(info.earlyBirdCutoff ?? info.scoringStart)} and your box office counts from the season start on {shortDate(info.scoringStart)}.
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Broadway shows only. Off-Broadway shows don&apos;t report grosses.
            </p>
          </div>

          {/* CriticScore */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-yellow-400/15 text-yellow-400 text-sm">★</span> CriticScore
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(CRITIC_SCORE_POINTS).map(([tier, pts]) => (
                <div key={tier} className="flex justify-between items-baseline gap-2">
                  <span className="text-gray-400">
                    {tier}
                    {CRITIC_TIER_RANGES[tier] && (
                      <span className="text-gray-500 font-mono text-xs ml-1.5">{CRITIC_TIER_RANGES[tier]}</span>
                    )}
                  </span>
                  <span className="font-mono text-gray-300 whitespace-nowrap">{pts} pts</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Based on Broadway Scorecard&apos;s critic composite score.
              Counts only for shows that had not opened yet when you drafted them.
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
            <p className="text-xs text-gray-500 mt-3">
              Same rule as CriticScore: counts only for shows that opened after you drafted them.
            </p>
          </div>
        </div>
      </section>

      {/* Season calendar */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">Season Calendar</h2>
        <div className="bg-surface-raised/50 rounded-xl p-6">
          <ol className="space-y-3 text-sm">
            {calendar.map(item => (
              <li key={item.label} className="flex gap-4">
                <span className="w-24 shrink-0 font-mono text-brand">{shortDate(item.date)}</span>
                <span className="text-gray-300">{item.label}</span>
              </li>
            ))}
          </ol>
          <div className="grid sm:grid-cols-3 gap-4 text-sm mt-6 pt-6 border-t border-white/5">
            <div>
              <span className="text-gray-500">Budget</span>
              <p className="text-white font-medium">${info.budget} for up to {info.teamSize} shows</p>
            </div>
            <div>
              <span className="text-gray-500">Draftable Shows</span>
              <p className="text-white font-medium">{info.broadwayShows} Broadway + {info.offBroadwayShows} Off-Broadway</p>
            </div>
            <div>
              <span className="text-gray-500">Scoring Period</span>
              <p className="text-white font-medium">{shortDate(info.scoringStart)} to {longDate(info.scoringEnd)}</p>
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
              a: `${PRIZE_DESCRIPTION}. Highest total points after Tony Awards night wins.`,
            },
            {
              q: 'Is it free?',
              a: 'Yes, completely free. No account needed. Enter your email to draft and we send you a confirmation with your picks.',
            },
            {
              q: 'When can I draft?',
              a: `Any time from ${longDate(DRAFT_OPENS)} until the deadline on ${longDate(deadlineDate)} at 11:59pm ET. The earlier you draft, the more your shows can earn: box office counts from the week you draft, and critic and audience points count only for shows that had not opened yet when you picked them. Draft by ${longDate(info.earlyBirdCutoff ?? info.scoringStart)} and your box office counts from the season start.`,
            },
            {
              q: 'Can I pick a show that has already opened?',
              a: 'Yes. It earns box office and awards points for you, but not critic or audience points, because those scores were public when you drafted. Its price is set with that in mind.',
            },
            {
              q: 'Can I change my picks after submitting?',
              a: 'No. Picks are final once submitted. One entry per email, locked in for the season. Draft carefully.',
            },
            {
              q: 'How do show prices work?',
              a: `Each show has a price from $${priceRange.min} to $${priceRange.max} based on how many points it is projected to earn: its Tony prospects, its box office outlook, how many weeks it runs, and, for shows that already opened, the score it has. Prices are set when the draft opens and do not change during the season. You have $${info.budget} for up to ${info.teamSize} slots, so you need a mix of big bets and value picks. Every price comes with a one-line rationale in the Draft Guide.`,
            },
            {
              q: 'What is the best strategy?',
              a: 'Awards are worth the most points, so pick shows likely to earn Tony nominations. Do not ignore box office: a hit musical earning $1M a week adds points every week. A few premium contenders plus some value sleepers usually beats going all-in on favorites.',
            },
            {
              q: 'What about shows that close early?',
              a: 'They keep the points they earned and stop earning box office. They can still earn Tony nominations and wins. A cheap show that lands a Best Play nomination is a big value pick.',
            },
            {
              q: 'What about Off-Broadway shows?',
              a: `${obRange ? `Priced $${obRange.min} to $${obRange.max}. ` : ''}They earn CriticScore and AudienceGrade points, plus Drama Desk, Outer Critics Circle, Lortel, and Obie awards. No box office and no Tony nominations.`,
            },
            {
              q: 'What if a new show is announced after I draft?',
              a: 'It joins the draftable list at a freshly set price so later drafters can pick it. Existing rosters do not change.',
            },
            {
              q: 'When do scores update?',
              a: 'Weekly. Box office data arrives on Tuesday and scores are recomputed every Wednesday. You get a weekly email with the latest standings.',
            },
            {
              q: 'What are leagues?',
              a: 'Optional private groups. Create a league to get an invite link, or type the same league name as your friends on the draft form. Your league standings show alongside the overall leaderboard.',
            },
            {
              q: 'How are ties broken?',
              a: 'Three tiebreaker questions on the draft form: how many nominations the most-nominated show will receive, which show will win Best Musical, and the total number of Tony nominations. Closest answers win.',
            },
            {
              q: 'Where do the scores come from?',
              a: 'CriticScore is Broadway Scorecard\'s composite of professional critic reviews. AudienceGrade comes from audience review platforms. Box office is the weekly Broadway grosses report. Awards are official nominations and wins from seven ceremonies.',
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
