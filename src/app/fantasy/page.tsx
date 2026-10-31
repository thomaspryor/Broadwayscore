import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { getFantasySeasonInfo, getFantasyShowsSorted } from '@/lib/data-fantasy';
import {
  CRITIC_SCORE_POINTS,
  AUDIENCE_GRADE_POINTS,
  BOX_OFFICE_POINTS_PER_100K,
  AWARDS_POINTS,
  AWARD_CEREMONY_COUNT,
  PRIZE_DESCRIPTION,
  DRAFT_OPENS,
  FANTASY_TONY_CEREMONY_YEAR,
  FANTASY_TONY_WINDOW,
  draftDeadlineDate,
  getCriticLabel,
  isShowOpenForDrafter,
  hasLateEntry,
  isDraftOpen,
  isDraftClosed,
  nyDate,
} from '@/config/fantasy';
import { SCORE_BUCKETS } from '@/config/score-buckets';
import FantasyMarquee from '@/components/fantasy/FantasyMarquee';
import { fantasySocial } from '@/config/fantasy-social';

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

// Regenerated every 15 minutes: the draft-window lines and "already open"
// lists change at midnight ET, and waiting for the next deploy (up to 6h)
// left them stale on draft day (BRO-5548 audit). The data is bundled JSON,
// so a regeneration needs nothing beyond the build.
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'Broadway Fantasy League',
  description: 'Draft up to 8 Broadway shows on a $100 budget. Earn points from critics, audiences, box office, and the Tony Awards. Free to play, no account needed.',
  alternates: { canonical: `${BASE_URL}/fantasy` },
  ...fantasySocial('Broadway Fantasy League', '/fantasy'),
};

export default function FantasyLandingPage() {
  const info = getFantasySeasonInfo();
  const shows = getFantasyShowsSorted();
  // "now" is the last regeneration (refreshed in the background every 15 minutes, see revalidate).
  // Broadway first: that's where box office points make an opened show worth a slot.
  // Broadway only in the list: an opened Off-Broadway show is worth awards
  // points alone, so it gets a count line instead of a row each.
  const openedNow = shows.filter(s => isShowOpenForDrafter(s) && s.status !== 'closed');
  const alreadyOpen = openedNow.filter(s => s.category !== 'off-broadway');
  const alreadyOpenOffBroadway = openedNow.length - alreadyOpen.length;
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

  // lateEntry: each team scores box office from the week it drafts, so
  // waiting costs grosses (owner, BRO-5478: Vulture's league rewarded waiting).
  const lateEntry = hasLateEntry();
  // An early-bird cutoff only means something when it falls after scoring starts.
  const earlyBird = info.earlyBirdCutoff && info.earlyBirdCutoff >= info.scoringStart ? info.earlyBirdCutoff : null;
  const calendar = lateEntry
    ? [
        { date: DRAFT_OPENS, label: 'Draft opens' },
        { date: info.scoringStart, label: 'Box office scoring starts. Each team scores from the week it drafts.' },
        ...(earlyBird ? [{ date: earlyBird, label: 'Early-bird cutoff: draft by this day and your box office counts from the season start' }] : []),
        { date: deadlineDate, label: 'Draft closes at 11:59pm ET. Picks are final.' },
        { date: FANTASY_TONY_WINDOW.end, label: `Tony eligibility cutoff: shows must open by this date to compete at the ${FANTASY_TONY_CEREMONY_YEAR} Tonys` },
        { date: info.scoringEnd, label: 'Tony Awards night (expected date): final standings' },
      ].sort((a, b) => a.date.localeCompare(b.date))
    : [
        { date: DRAFT_OPENS, label: 'Draft opens' },
        { date: deadlineDate, label: 'Draft closes at 11:59pm ET. Picks are final.' },
        { date: info.scoringStart, label: 'Box office scoring starts for every team' },
        { date: FANTASY_TONY_WINDOW.end, label: `Tony eligibility cutoff: shows must open by this date to compete at the ${FANTASY_TONY_CEREMONY_YEAR} Tonys` },
        { date: info.scoringEnd, label: 'Tony Awards night (expected date): final standings' },
      ];

  // As of the last regeneration (see revalidate).
  const now = new Date();
  const todayNy = nyDate(now.toISOString());
  const preDraft = !isDraftOpen(now) && !isDraftClosed(now);
  // One sentence per line (owner 2026-10-17).
  const draftStatus: string[] = isDraftClosed(now)
    ? ['The draft is closed.', 'Follow the race on the leaderboard.']
    : isDraftOpen(now)
      ? ['The draft is open.', `Picks are due ${longDate(deadlineDate)} at 11:59pm ET.`, ...(lateEntry ? ['Box office counts from the week you draft, so get in early.'] : [])]
      : [`Draft opens ${longDate(DRAFT_OPENS)}.`, `Picks are due ${longDate(deadlineDate)}.`, ...(lateEntry ? ['Box office counts from the week you draft, so get in early.'] : [])];

  return (
    <div className="min-h-screen bg-surface text-white">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-12 sm:pt-20 pb-12 text-center">
        {/* The marquee is the name (BRO-5519); the headline says what the game rewards. */}
        <h1 className="mb-6">
          <FantasyMarquee
            animated
            decorative
            className="block mx-auto w-[300px] sm:w-[440px] h-auto drop-shadow-[0_0_24px_rgba(255,224,138,0.18)]"
          />
          <span className="sr-only">Broadway Fantasy League</span>
        </h1>
        <p className="text-xs font-semibold uppercase tracking-widest text-brand mb-3">{seasonLabel} season</p>
        <p className="text-3xl sm:text-4xl font-black leading-tight sm:leading-tight tracking-tight text-white text-balance mb-2">Call the hits before opening night.</p>
        <p className="text-lg sm:text-xl font-semibold text-brand mb-4">Pick once. Root all season.</p>
        <p className="text-lg sm:text-xl text-gray-300 max-w-xl mx-auto mb-3">
          Draft up to {info.teamSize} shows on a ${info.budget} budget.
          Earn points from critics, audiences, box office, and the Tony Awards.
        </p>
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 bg-brand/10 border border-brand/20 rounded-full px-4 py-1.5">
            <span className="text-brand text-sm font-bold">Winner gets {PRIZE_DESCRIPTION}</span>
          </span>
          <p className="text-sm text-gray-400 mt-3">
            {draftStatus.map(line => <span key={line} className="block text-balance">{line}</span>)}
          </p>
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

      {/* Season calendar, right under the hero (owner 2026-10-17) */}
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
          <p className="text-sm text-gray-400 mt-3">
            A flop earns a few box office points and little else. That gap is the whole game.
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
            <p className="text-sm text-gray-400 mb-2">{AWARD_CEREMONY_COUNT} ceremonies: Tonys, Drama Desk, Outer Critics, Drama League, NYDCC, Lortel</p>
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
            </div>
            <p className="text-sm text-gray-400 mt-2">
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
              {lateEntry ? (
                <>
                  {' '}Your shows earn it from the week you draft (Monday to Sunday weeks, starting {shortDate(info.scoringStart)}) through Tony Awards night, so every week you wait costs you a week of grosses.
                  {earlyBird && <> Draft by {shortDate(earlyBird)} and your box office counts from the season start.</>}
                </>
              ) : (
                <> Every team&apos;s box office counts from {shortDate(info.scoringStart)} through Tony Awards night.</>
              )}
            </p>
            <p className="text-sm text-gray-400 mt-2">
              Broadway shows only. Off-Broadway shows don&apos;t report grosses.
            </p>
          </div>

          {/* CriticScore */}
          <div className="bg-surface-raised/50 rounded-xl p-5 border border-white/5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${SCORE_BUCKETS[0].bgColor} ${SCORE_BUCKETS[0].color} text-sm`}>★</span> CriticScore
            </h3>
            <div className="space-y-1.5 text-sm">
              {Object.entries(CRITIC_SCORE_POINTS).map(([tier, pts]) => (
                <div key={tier} className="flex justify-between items-baseline gap-2">
                  <span className="text-gray-400">
                    {tier}
                    {CRITIC_TIER_RANGES[tier] && (
                      <span className="text-gray-400 font-mono text-sm ml-1.5">{CRITIC_TIER_RANGES[tier]}</span>
                    )}
                  </span>
                  <span className="font-mono text-gray-300 whitespace-nowrap">{pts} pts</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-gray-400 mt-3">
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
            <p className="text-sm text-gray-400 mt-3">
              Counts only if the show&apos;s audience grade was not out yet when you drafted it. Audience reviews start in previews, so a grade can appear before opening night.
            </p>
          </div>
        </div>
      </section>

      {/* Already open: a scoring exception, so it follows the scoring rules (owner 2026-10-17: leading with it made no sense) */}
      {openedNow.length > 0 && (
        <section className="max-w-3xl mx-auto px-4 py-6">
          <div className="bg-surface-raised/50 rounded-xl p-6 border border-brand/20">
            <h2 className="text-lg font-bold mb-2">
              {preDraft
                ? `${openedNow.length === 1 ? 'One show opens' : `${openedNow.length} shows open`} before the draft does`
                : `${openedNow.length === 1 ? 'One show has' : `${openedNow.length} shows have`} already opened`}
            </h2>
            <p className="text-sm text-gray-400 mb-3">
              {preDraft ? 'Their reviews will be out before the draft opens' : 'Their reviews are already out'}. You can still pick them, but they score box office and awards points only.
              The same goes for any show that opens before you draft: critic and audience points go only to players who picked it before its opening day.
            </p>
            <ul className="text-sm text-gray-300 space-y-2">
              {alreadyOpen.map(s => (
                <li key={s.id} className="flex items-start justify-between gap-4">
                  <span className="min-w-0">
                    <span className="block">{s.title}</span>
                    <span className="block text-sm text-gray-400">
                      {s.criticScore != null && <>CriticScore {Math.round(s.criticScore)}</>}
                      {s.criticScore != null && s.openingDate && ' · '}
                      {s.openingDate && <>{s.openingDate > todayNy ? 'opens' : 'opened'} {shortDate(s.openingDate)}</>}
                    </span>
                  </span>
                  <span className="font-mono text-emerald-400 shrink-0">${s.price}</span>
                </li>
              ))}
            </ul>
            {alreadyOpenOffBroadway > 0 && (
              <p className="text-sm text-gray-400 mt-3">
                {alreadyOpenOffBroadway === 1 ? 'Plus one Off-Broadway show' : `Plus ${alreadyOpenOffBroadway} Off-Broadway shows`} (no box office, so awards points only). All are in the <a href="/fantasy/guide" className="text-brand/80 hover:text-brand">Draft Guide</a>.
              </p>
            )}
          </div>
        </section>
      )}

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">FAQ</h2>
        <div className="space-y-2">
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
              a: lateEntry
                ? `From ${longDate(DRAFT_OPENS)} until ${longDate(deadlineDate)} at 11:59pm ET, then the draft is closed for the season. Draft early: box office counts from the week you draft (Monday to Sunday weeks, starting ${longDate(info.scoringStart)}), so every week you wait costs your shows a week of grosses. Critic and audience points count only for shows that had not opened yet when you picked them.${earlyBird ? ` Draft by ${longDate(earlyBird)} and your box office counts from the season start.` : ''}`
                : `From ${longDate(DRAFT_OPENS)} until ${longDate(deadlineDate)} at 11:59pm ET. After that the draft is closed for the season. Box office counts for every team from ${longDate(info.scoringStart)}, whenever in the window you draft. Critic and audience points count only for shows that had not opened yet when you picked them, so drafting before a November opening night can pay off.`,
            },
            {
              q: 'Can I pick a show that has already opened?',
              a: 'Yes. It earns box office and awards points for you, but not critic or audience points, because those scores were public when you drafted. A show counts as opened from its opening day, so to earn its critic and audience points, pick it by the day before. The same goes for audience points on a show in previews that already has an audience grade: the draft form marks those.',
            },
            {
              q: 'Can I change my picks after submitting?',
              a: 'No. Picks are final once submitted. One entry per person, locked in for the season. Draft carefully.',
            },
            {
              q: 'How do show prices work?',
              a: `Each show has a price from $${priceRange.min} to $${priceRange.max} based on how many points it is projected to earn: its Tony prospects, its box office outlook, how many weeks it runs, and, for shows that already opened, the score it has. Prices are set when the draft opens and do not change during the season. You have $${info.budget} for up to ${info.teamSize} slots, so you need a mix of big bets and value picks.`,
            },
            {
              q: 'What about shows that close early?',
              a: 'They keep the points they earned and stop earning box office. They can still earn Tony nominations and wins. A cheap show that lands a Best Play nomination is a big value pick.',
            },
            {
              q: 'What if a show I picked is postponed or cancelled?',
              a: `Picks are final, so there are no swaps. A show that is cancelled, or moves its opening past the Tony eligibility cutoff on ${longDate(FANTASY_TONY_WINDOW.end)}, keeps whatever it already earned but cannot score Tony points this season. Spring shows that have not started previews carry that risk.`,
            },
            {
              q: 'What about Off-Broadway shows?',
              a: `${obRange ? `Priced $${obRange.min} to $${obRange.max}. ` : ''}They earn CriticScore and AudienceGrade points, plus Drama Desk, Outer Critics Circle, Drama League, and Lortel awards. No box office and no Tony nominations.`,
            },
            {
              q: 'What if a new show is announced after I draft?',
              a: `If it is announced while the draft is open, it joins the list at a freshly set price. Existing rosters do not change. Shows announced after ${longDate(deadlineDate)} are not part of this season's game.`,
            },
            {
              q: 'When do scores update?',
              a: 'Every day for critic, audience and awards points. Box office arrives weekly: the Broadway grosses come out on Tuesday. Players get a weekly email with the standings.',
            },
            {
              q: 'What are leagues?',
              a: 'Optional private groups. Create a league to get an invite link, or type the same league name as your friends on the draft form. Join before you submit: picks and league are both final. Your league standings show alongside the overall leaderboard.',
            },
            {
              q: 'How are ties broken?',
              a: 'Three tiebreaker questions on the draft form: how many nominations the most-nominated show will receive, which show will win Best Musical, and the total number of Tony nominations. Closest answers win.',
            },
            {
              q: 'Who can enter, and how is the winner picked?',
              a: `Anyone 18 or older, free, no purchase needed. One entry per person: entries from the same person under different email addresses are all disqualified. After Tony Awards night we email the top team at the address it drafted with. The winner has 14 days to reply, or the prize passes to the next team.`,
            },
            {
              q: 'Where do the scores come from?',
              a: `CriticScore is Broadway Scorecard's composite of professional critic reviews. AudienceGrade comes from audience review platforms. Box office is the weekly Broadway grosses report. Awards are official nominations and wins from ${AWARD_CEREMONY_COUNT} ceremonies.`,
            },
          ].map(({ q, a }) => (
            <details key={q} className="group bg-surface-raised/30 rounded-xl">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-3 p-4 text-base font-medium text-white">
                <span>{q}</span>
                <span aria-hidden className="text-gray-400 transition-transform group-open:rotate-45 text-xl leading-none">+</span>
              </summary>
              <p className="px-4 pb-4 text-base text-gray-300">{a}</p>
            </details>
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
