import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: `Going to Broadway for the First Time (${currentYear}) | Complete Beginner Guide`,
  description: `Everything you need to know before your first Broadway show in ${currentYear}. When to arrive, what to expect, theater etiquette, practical tips, and how to plan the perfect night out.`,
  alternates: { canonical: `${BASE_URL}/guides/broadway-first-timer-guide` },
  openGraph: {
    title: `Your First Broadway Show: The Complete Guide (${currentYear})`,
    description: `First time on Broadway? Here's what to expect — from buying tickets to stage door, with practical tips from experienced theatergoers.`,
    url: `${BASE_URL}/guides/broadway-first-timer-guide`,
    type: 'article',
  },
};

export default function BroadwayFirstTimerGuide() {
  const allShows = getBroadwayShows();
  const openShowCount = allShows.filter(s => s.status === 'open').length;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
    { name: 'First-Timer Guide', url: `${BASE_URL}/guides/broadway-first-timer-guide` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How early should I arrive for a Broadway show?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Plan to arrive at the theater 30 minutes before curtain. This gives you time to pick up Will Call tickets, pass through security, find your seat, and use the restroom. If you have Will Call or mobile tickets that need to be exchanged at the box office, arrive even earlier — the line can take 10-15 minutes before popular shows.',
        },
      },
      {
        '@type': 'Question',
        name: 'Can I take photos during a Broadway show?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'No. Photography, video recording, and audio recording are strictly prohibited during Broadway performances. This is both a legal requirement (the production holds the rights) and a courtesy to performers and fellow audience members. You can take photos in the lobby before or after the show. Some shows allow a quick photo of the stage before the performance begins, but once the lights go down, phones must be silenced and put away.',
        },
      },
      {
        '@type': 'Question',
        name: 'How long is a typical Broadway show?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Most Broadway musicals run 2 to 2.5 hours including a 15-20 minute intermission. Plays tend to be shorter, usually 90 minutes to 2 hours, and some plays run straight through without an intermission. Check the show listing before you go so you can plan dinner or transportation accordingly.',
        },
      },
      {
        '@type': 'Question',
        name: 'What should I wear to Broadway?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `There is no formal dress code for Broadway. Most people wear smart casual — a nice top and jeans, a dress, or business casual. You will see everything from suits to sneakers. The key is to be comfortable (you will be sitting for 2+ hours) while looking put-together. For a detailed breakdown of what to wear by season and occasion, see our complete guide: ${BASE_URL}/guides/what-to-wear-to-broadway`,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, faqSchema]) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Guides', href: '/guides' },
          { label: 'First-Timer Guide' },
        ]} />

        {/* Back Link */}
        <Link href="/guides" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Guides
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Going to Broadway for the First Time ({currentYear})
          </h1>
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">
            Your first Broadway show is a big deal, and a little planning goes a long way.
            This guide covers everything you need to know — from buying tickets and getting to the theater,
            to what happens inside, etiquette, and what to do after the curtain call.
            With <span className="text-brand font-semibold">{openShowCount} shows</span> currently
            running on Broadway, there has never been a better time to go.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Table of Contents */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">Jump to Section</h2>
          <ul className="space-y-2 text-sm">
            <li><a href="#before-you-go" className="text-brand hover:text-brand-hover">Before You Go</a></li>
            <li><a href="#getting-tickets" className="text-brand hover:text-brand-hover">Getting Tickets</a></li>
            <li><a href="#at-the-theater" className="text-brand hover:text-brand-hover">What to Expect at the Theater</a></li>
            <li><a href="#during-the-show" className="text-brand hover:text-brand-hover">During the Show</a></li>
            <li><a href="#etiquette" className="text-brand hover:text-brand-hover">Theater Etiquette</a></li>
            <li><a href="#practical-tips" className="text-brand hover:text-brand-hover">Practical Tips</a></li>
            <li><a href="#after-the-show" className="text-brand hover:text-brand-hover">After the Show</a></li>
            <li><a href="#picking-your-show" className="text-brand hover:text-brand-hover">Picking Your First Show</a></li>
            <li><a href="#faq" className="text-brand hover:text-brand-hover">FAQ</a></li>
          </ul>
        </div>

        {/* Before You Go */}
        <section id="before-you-go" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Before You Go</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              A little advance planning makes a big difference. Here is what to think about before you
              even set foot in a theater.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">When to Buy Tickets</h3>
              <div className="space-y-3 text-gray-300">
                <p>
                  <strong className="text-white">For hit shows:</strong> Buy 2-4 weeks in advance.
                  Blockbusters like Hamilton, Wicked, and The Lion King can sell out months ahead,
                  especially on weekends. The sooner you book, the better your seat selection.
                </p>
                <p>
                  <strong className="text-white">For newer or less popular shows:</strong> You can often buy
                  a few days before, or even same-day. This is where discount options like TKTS and lotteries
                  really shine.
                </p>
                <p>
                  <strong className="text-white">Last-minute plans:</strong> Totally doable. Between the TKTS booth,
                  digital lotteries, and rush tickets, there are almost always options available day-of. Just be
                  flexible about which show you see.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Best Days and Times</h3>
              <div className="space-y-3 text-gray-300">
                <p>
                  Not all performance times are created equal. Here is a quick breakdown:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="card p-3 bg-emerald-500/10 border border-emerald-500/20">
                    <strong className="text-emerald-400 block mb-1">Best value</strong>
                    Tuesday, Wednesday, and Thursday evenings tend to be the cheapest and
                    least crowded. You will also find better lottery and rush odds on these nights.
                  </div>
                  <div className="card p-3 bg-red-500/10 border border-red-500/20">
                    <strong className="text-red-400 block mb-1">Most expensive</strong>
                    Saturday evening is consistently the priciest performance. Friday evening
                    is the second most expensive. Weekend demand is highest.
                  </div>
                  <div className="card p-3 bg-blue-500/10 border border-blue-500/20">
                    <strong className="text-blue-400 block mb-1">Matinees</strong>
                    Wednesday and Saturday matinees (typically 2pm) are popular with tourists
                    and families. Sunday matinees (3pm) are common too. Prices vary but are
                    generally lower than weekend evenings.
                  </div>
                  <div className="card p-3 bg-yellow-500/10 border border-yellow-500/20">
                    <strong className="text-yellow-400 block mb-1">Monday</strong>
                    Most Broadway shows are dark (closed) on Mondays. A few shows perform,
                    so always check the schedule before planning a Monday outing.
                  </div>
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">Matinee vs. Evening</h3>
              <div className="text-gray-300 space-y-2 text-sm">
                <p>
                  <strong className="text-white">Matinees</strong> are great if you want to see a show and still
                  have your evening free for dinner. They tend to draw families and older audiences, so the
                  energy can be a bit more subdued. Good choice if you are visiting with kids.
                </p>
                <p>
                  <strong className="text-white">Evening shows</strong> (typically 7pm or 8pm) have a special buzz
                  to them — getting dressed up, walking through the Theater District at night, the neon and
                  energy of Times Square. If this is your first time and you want the full experience, an evening
                  performance is hard to beat.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Getting Tickets */}
        <section id="getting-tickets" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Getting Tickets</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              There are more ways to get Broadway tickets than most people realize. Here is a quick
              overview — we have a{' '}
              <Link href="/guides/cheap-broadway-tickets" className="text-brand hover:text-brand-hover font-medium">
                full guide to cheap Broadway tickets
              </Link>{' '}
              if you want the deep dive.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Your Main Options</h3>
              <div className="space-y-3 text-gray-300">
                <div>
                  <strong className="text-white">Buy online:</strong> The most straightforward route. Purchase
                  through the show&apos;s official website, Telecharge, or Ticketmaster. You will pay a service fee
                  ($10-15 per ticket), but you get to pick your exact seats and buy at your own pace.
                </div>
                <div>
                  <strong className="text-white">TKTS booth:</strong> Same-day tickets at 20-50% off in Times Square
                  and two other locations. Great for first-timers who are flexible about which show to see.
                </div>
                <div>
                  <strong className="text-white">Digital lotteries:</strong> Enter on apps like TodayTix for
                  a chance to win $30-40 orchestra seats. Free to enter, results come a few hours before showtime.{' '}
                  <Link href="/lotteries" className="text-brand hover:text-brand-hover">
                    See current lottery shows
                  </Link>.
                </div>
                <div>
                  <strong className="text-white">Rush tickets:</strong> Same-day discounted tickets ($30-50) available
                  at the box office or online when they open. First-come, first-served.{' '}
                  <Link href="/rush" className="text-brand hover:text-brand-hover">
                    See current rush shows
                  </Link>.
                </div>
                <div>
                  <strong className="text-white">Box office:</strong> You can always walk up to the theater&apos;s box
                  office and buy directly. No service fees, and the staff can help you pick the best available seats.
                  This is underrated — especially for shows that are not sold out.
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-yellow-500/10 border border-yellow-500/20">
              <h3 className="font-bold text-yellow-400 mb-2">Watch Out for Resellers</h3>
              <p className="text-gray-300 text-sm">
                Stick to official sources. Third-party resellers (StubHub, Vivid Seats, etc.) charge significant
                markups — sometimes 2-3x face value. If you see someone selling tickets on the street in Times
                Square, walk away. Counterfeit tickets are a real problem, and there is no recourse if you get scammed.
              </p>
            </div>
          </div>
        </section>

        {/* What to Expect at the Theater */}
        <section id="at-the-theater" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">What to Expect at the Theater</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Walking into a Broadway theater for the first time can be a little overwhelming. Here is a
              step-by-step walkthrough so you know exactly what to expect.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Arrival (30 Minutes Before Curtain)</h3>
              <ol className="text-gray-300 space-y-3 list-decimal list-inside">
                <li>
                  <strong className="text-white">Get there early.</strong> Aim for 30 minutes before the listed
                  showtime. The Theater District gets crowded, and you will want time to settle in. If you have
                  Will Call tickets to pick up, add another 10-15 minutes.
                </li>
                <li>
                  <strong className="text-white">Find the right entrance.</strong> Most Broadway theaters have
                  the main entrance on the street, clearly marked with the show&apos;s marquee. Check your ticket
                  for the theater name and address — some theaters are on side streets, not the main avenues.
                </li>
                <li>
                  <strong className="text-white">Security check.</strong> All Broadway theaters have bag checks.
                  Open your bag for the security staff at the door. Large bags and backpacks may need to be
                  checked at coat check. This goes quickly — it is not airport-level security.
                </li>
                <li>
                  <strong className="text-white">Pick up your Playbill.</strong> An usher will hand you a free
                  Playbill (the show&apos;s program) as you enter the auditorium. It includes the cast list,
                  creative team, synopsis, and articles about the production. It is a nice keepsake.
                </li>
                <li>
                  <strong className="text-white">Find your seat.</strong> Ushers are stationed throughout the
                  theater and will help you find your seat. Tip: use the restroom before you sit down — you do
                  not want to be climbing over people once the show starts.
                </li>
              </ol>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Will Call and Mobile Tickets</h3>
              <div className="text-gray-300 space-y-2">
                <p>
                  <strong className="text-white">Will Call:</strong> If your tickets are held at the box office
                  (common with lottery wins and some online purchases), bring a valid photo ID and the credit card
                  used for purchase. The Will Call window is usually separate from the main ticket window.
                </p>
                <p>
                  <strong className="text-white">Mobile tickets:</strong> Many shows now accept mobile tickets on
                  your phone. Have your ticket loaded and your screen brightness turned up before you get to the
                  door. Screenshot your ticket in case you lose cell service.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* During the Show */}
        <section id="during-the-show" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">During the Show</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Here is what a typical Broadway performance looks like from start to finish.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">The Performance</h3>
              <div className="space-y-3 text-gray-300">
                <div>
                  <strong className="text-white">Before curtain:</strong> The house lights will dim, and you may hear
                  an announcement asking you to silence your phone and unwrap any candy. For musicals, the orchestra
                  will begin the overture — this is part of the show, so settle in and enjoy it. Some modern
                  musicals skip the traditional overture and go straight into the opening number.
                </div>
                <div>
                  <strong className="text-white">Act One:</strong> Most shows have two acts. Act One typically runs
                  45-75 minutes. Sit back, relax, and take it all in. Do not worry about when to clap — follow
                  the audience&apos;s lead. It is natural to applaud after musical numbers, but not required during
                  dramatic scenes.
                </div>
                <div>
                  <strong className="text-white">Intermission:</strong> A 15-20 minute break between acts. The house
                  lights come up and you are free to get up, stretch, use the restroom, or grab a drink. Most
                  theaters have a bar or concession stand in the lobby.
                </div>
                <div>
                  <strong className="text-white">Act Two:</strong> Usually a bit shorter than Act One. A chime or
                  announcement will signal when intermission is ending — head back to your seat promptly. Late
                  returns may have to wait for a scene break before being seated.
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Intermission Tips</h3>
              <div className="text-gray-300 space-y-2 text-sm">
                <p>
                  <strong className="text-white">Restrooms:</strong> Lines can be long, especially for women&apos;s
                  rooms. Head there as soon as the lights come up if you need to go.
                </p>
                <p>
                  <strong className="text-white">Drinks and snacks:</strong> Most theaters sell wine, beer, cocktails,
                  water, and candy at the lobby bar. Prices are steep (expect $15+ for a cocktail). Some theaters let
                  you pre-order intermission drinks before the show so they are ready when you come out. Cash and
                  cards are both accepted.
                </p>
                <p>
                  <strong className="text-white">Timing:</strong> Intermission goes fast. If you want to use the
                  restroom and grab a drink, pick one and plan to do the other after the show.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Curtain Call and Applause</h3>
              <div className="text-gray-300 space-y-2">
                <p>
                  When the show ends, the cast takes their bows — this is the curtain call. It is customary to
                  applaud as each performer or group comes out. The lead actors typically bow last and get the biggest
                  ovation.
                </p>
                <p>
                  <strong className="text-white">Standing ovations:</strong> Standing ovations are common on Broadway,
                  but not mandatory. If the people around you stand, it is polite to join in. If the show truly moved
                  you, stand. If you thought it was just okay, a seated applause is perfectly fine — nobody will judge you.
                </p>
                <p>
                  <strong className="text-white">When to clap:</strong> After big musical numbers, at the end of
                  scenes, and during curtain call. If you are not sure, wait a beat and follow the crowd.
                  During dramatic plays, applause is less frequent — usually just at scene endings and curtain call.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Theater Etiquette */}
        <section id="etiquette" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Theater Etiquette</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Broadway etiquette is mostly common sense, but a few things trip up first-timers. These are not
              stuffy rules — they are about making sure everyone (including the performers) has a great experience.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <div className="space-y-4 text-gray-300">
                <div>
                  <strong className="text-white">Silence your phone completely.</strong> Not vibrate — silent.
                  A buzzing phone in a quiet theater is surprisingly loud. Better yet, turn it off. Under no
                  circumstances should you check your phone during the performance. The glow of a screen in a
                  dark theater is incredibly distracting to everyone around you and to the performers on stage.
                </div>
                <div>
                  <strong className="text-white">Do not talk during the show.</strong> Even whispering carries in a
                  theater. Save your reactions for intermission or after the show. If you need to say something truly
                  urgent, lean in and keep it to two words.
                </div>
                <div>
                  <strong className="text-white">Do not sing along.</strong> Even if you know every word. The
                  audience paid to hear the performers, not the person in Row G. The one exception: some shows
                  have singalong moments where the cast invites the audience to join in — you will know when.
                </div>
                <div>
                  <strong className="text-white">Unwrap candy and cough drops before the show.</strong> Crinkling
                  wrappers are one of the most common complaints from both audiences and performers. Open everything
                  before the lights go down.
                </div>
                <div>
                  <strong className="text-white">Do not put your feet on the seat in front of you.</strong> Somebody
                  is sitting there (or will be after intermission). Theaters are tight — be mindful of your space.
                </div>
                <div>
                  <strong className="text-white">No photos or recording.</strong> This is a legal issue, not just
                  a courtesy. Unauthorized recording can result in your removal from the theater. Enjoy the show
                  with your eyes, not your lens.
                </div>
                <div>
                  <strong className="text-white">Be aware of your neighbors.</strong> Avoid strong perfume or cologne.
                  Do not lean forward if someone is behind you. Keep your belongings in your lap or under your seat, not
                  spilling into the next seat. If you have a tall hairstyle or hat, consider the person behind you.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Practical Tips */}
        <section id="practical-tips" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Practical Tips</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              The things nobody tells you until you have been a few times.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">Coat Check</h3>
                <p className="text-gray-300 text-sm">
                  Most theaters have coat check in the lobby, typically $2-3 per item. Worth it in winter — you
                  do not want a heavy coat on your lap for two hours. Tip: coat check lines get long right before
                  curtain, so check your coat as soon as you arrive.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">Temperature</h3>
                <p className="text-gray-300 text-sm">
                  Broadway theaters are air-conditioned aggressively, even in summer. Bring a light layer — a
                  cardigan, light jacket, or scarf. This is one of the most common complaints from first-timers,
                  especially in mezzanine and balcony seats where the AC hits hardest.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">Restrooms</h3>
                <p className="text-gray-300 text-sm">
                  Broadway theaters were built in an era when audiences were smaller and restrooms were an afterthought.
                  Go before the show starts if you can. During intermission, the lines (especially for women) can eat
                  up most of the break. Some theaters have restrooms on upper floors with shorter lines.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">Food and Drink</h3>
                <p className="text-gray-300 text-sm">
                  Most theaters sell drinks and snacks in the lobby before the show and during intermission. Outside
                  food is generally not allowed. If you want to eat beforehand, the Theater District has tons of
                  options — just plan to finish 30-45 minutes before showtime.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">Accessibility</h3>
                <p className="text-gray-300 text-sm">
                  All Broadway theaters offer wheelchair-accessible seating, assistive listening devices, and many
                  offer audio description and open captioning performances. Contact the box office directly when
                  booking — they can arrange the best options for your needs. Service animals are welcome.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2 text-sm">What to Wear</h3>
                <p className="text-gray-300 text-sm">
                  There is no dress code. Smart casual is the norm — think nice jeans and a blouse, or a casual
                  dress. Comfortable shoes are a must (you may be walking several blocks to the theater). For a full
                  breakdown, see our{' '}
                  <Link href="/guides/what-to-wear-to-broadway" className="text-brand hover:text-brand-hover">
                    what to wear to Broadway guide
                  </Link>.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">First-Timer Checklist</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>-- Tickets (on your phone with a screenshot, or printed)</li>
                <li>-- Photo ID (if picking up at Will Call)</li>
                <li>-- A light layer (theaters are cold)</li>
                <li>-- Small bag (large bags need to be checked)</li>
                <li>-- Cash for coat check and stage door tips (optional)</li>
                <li>-- Candy/cough drops pre-unwrapped</li>
                <li>-- Charged phone (then silence it)</li>
              </ul>
            </div>
          </div>
        </section>

        {/* After the Show */}
        <section id="after-the-show" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">After the Show</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              The experience does not have to end when the curtain comes down.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Stage Door</h3>
              <div className="text-gray-300 space-y-2">
                <p>
                  After most Broadway shows, cast members come out the stage door to greet fans, sign autographs,
                  and take photos. This is one of the best parts of the Broadway experience, especially for first-timers.
                </p>
                <p>
                  <strong className="text-white">How it works:</strong> The stage door is usually on the side or back
                  of the theater (ask an usher for directions). Head there right after the show — a crowd will already
                  be forming. Wait patiently. Actors typically start coming out 10-30 minutes after the final bow.
                  Not every cast member will come out every night, so do not take it personally if your favorite
                  performer skips.
                </p>
                <p>
                  <strong className="text-white">What to bring:</strong> A Sharpie marker for autographs. Your
                  Playbill is the traditional thing to get signed. A phone for photos. Be polite and quick — there
                  are a lot of people waiting.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Getting Home</h3>
              <div className="text-gray-300 space-y-2 text-sm">
                <p>
                  <strong className="text-white">Subway:</strong> By far the fastest way out of the Theater District.
                  Times Square-42nd St (1/2/3/7/N/Q/R/W/S) and 50th St (1) are the closest stations. Trains run
                  late — you will not get stranded.
                </p>
                <p>
                  <strong className="text-white">Rideshare (Uber/Lyft):</strong> Expect surge pricing after evening
                  shows when thousands of theatergoers are all requesting rides at once. Walk a few blocks east or
                  south to escape the worst of it.
                </p>
                <p>
                  <strong className="text-white">Driving:</strong> Avoid 8th Avenue after shows — it turns into
                  gridlock when every theater lets out at the same time. If you drove, park east of Broadway and
                  exit heading east.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Dinner and Drinks</h3>
              <div className="text-gray-300 space-y-2 text-sm">
                <p>
                  <strong className="text-white">Before the show:</strong> Restaurant Row (46th St between 8th and
                  9th Avenues) is the classic pre-theater dinner spot. Many restaurants offer prix fixe pre-theater
                  menus designed to get you out by curtain. Make a reservation.
                </p>
                <p>
                  <strong className="text-white">After the show:</strong> Hell&apos;s Kitchen (9th and 10th Avenues,
                  40s-50s) is the go-to neighborhood for post-show dining. It is walkable from every Broadway
                  theater and has restaurants at every price point. No reservation? Try 9th Avenue — plenty of spots
                  that take walk-ins even at 10:30pm.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Picking Your First Show */}
        <section id="picking-your-show" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Picking Your First Show</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              With {openShowCount} shows currently running on Broadway, choosing your first one can feel
              overwhelming. Here are a few principles to keep in mind:
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <div className="space-y-3 text-gray-300">
                <p>
                  <strong className="text-white">Go with what excites you.</strong> If there is a show you have been
                  hearing about, a performer you love, or a story that speaks to you — that is your show. Do not
                  overthink it.
                </p>
                <p>
                  <strong className="text-white">Musicals are a safe bet for first-timers.</strong> They are
                  visually stunning, emotionally engaging, and the music carries you through even if you are not
                  used to live theater. That said, a great play can be equally powerful — it is a more intimate
                  experience.
                </p>
                <p>
                  <strong className="text-white">Check the reviews.</strong> Critic scores give you a sense of quality,
                  but read a few reviews to see if the tone and subject matter match what you are looking for.
                  A show with a 90+ score might not be right for you if it is a heavy drama and you want a fun night out.
                </p>
                <p>
                  <strong className="text-white">Consider runtime.</strong> If you are not sure how you will handle
                  sitting for a long show, start with something under two hours or a show with an intermission.
                  You can always work your way up to the three-hour epics.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-surface-overlay">
              <h3 className="font-bold text-white mb-3">Our First-Timer Resources</h3>
              <div className="space-y-2">
                <Link href="/guides/best-broadway-shows-for-first-timers" className="block text-brand hover:text-brand-hover text-sm font-medium">
                  Best Broadway Shows for First-Timers — curated recommendations with scores and reviews
                </Link>
                <Link href="/browse/first-time-broadway" className="block text-brand hover:text-brand-hover text-sm font-medium">
                  Browse First-Timer Shows — full filterable list of beginner-friendly shows
                </Link>
                <Link href="/broadway-theaters-map" className="block text-brand hover:text-brand-hover text-sm font-medium">
                  Broadway Theaters Map — see where every theater is located
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">Frequently Asked Questions</h2>
          <div className="space-y-4">
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">How early should I arrive for a Broadway show?</h3>
              <p className="text-gray-300 text-sm">
                Plan to arrive 30 minutes before curtain. This gives you time to pick up Will Call tickets, pass
                through security, find your seat, and use the restroom. If you have tickets to pick up at the box
                office, add another 10-15 minutes — the Will Call line can move slowly before popular shows.
              </p>
            </div>
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Can I take photos during a Broadway show?</h3>
              <p className="text-gray-300 text-sm">
                No. Photography, video recording, and audio recording are strictly prohibited during performances.
                You can take photos in the lobby before or after the show. Some shows allow a quick photo of the
                stage before the performance begins, but once the lights go down, phones must be put away completely.
              </p>
            </div>
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">How long is a typical Broadway show?</h3>
              <p className="text-gray-300 text-sm">
                Most musicals run 2 to 2.5 hours including a 15-20 minute intermission. Plays tend to be shorter —
                usually 90 minutes to 2 hours — and some run straight through without an intermission. Check the
                show&apos;s listing before you go so you can plan dinner or transportation accordingly.
              </p>
            </div>
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">What should I wear to Broadway?</h3>
              <p className="text-gray-300 text-sm">
                There is no formal dress code. Smart casual is the sweet spot — nice jeans and a top, a casual dress,
                or business casual all work well. You will see everything from cocktail dresses to sneakers. The key
                is to be comfortable for 2+ hours of sitting. For a complete breakdown by season, venue, and occasion,
                check our{' '}
                <Link href="/guides/what-to-wear-to-broadway" className="text-brand hover:text-brand-hover">
                  what to wear to Broadway guide
                </Link>.
              </p>
            </div>
          </div>
        </section>

        {/* Related Guides */}
        <div className="card p-4 sm:p-5 mb-8 bg-surface-overlay">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">Related Guides</h2>
          <div className="space-y-2">
            <Link href="/guides/cheap-broadway-tickets" className="block text-brand hover:text-brand-hover text-sm">
              How to Get Cheap Broadway Tickets
            </Link>
            <Link href="/guides/what-to-wear-to-broadway" className="block text-brand hover:text-brand-hover text-sm">
              What to Wear to Broadway
            </Link>
            <Link href="/guides/best-broadway-shows-for-first-timers" className="block text-brand hover:text-brand-hover text-sm">
              Best Broadway Shows for First-Timers
            </Link>
            <Link href="/guides/off-broadway-vs-broadway" className="block text-brand hover:text-brand-hover text-sm">
              Off-Broadway vs. Broadway: What&apos;s the Difference?
            </Link>
            <Link href="/broadway-theaters-map" className="block text-brand hover:text-brand-hover text-sm">
              Broadway Theaters Map
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
