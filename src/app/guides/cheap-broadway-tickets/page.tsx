import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import { getLotteryRush, getLotteryShowCount, getRushShowCount } from '@/lib/data-lottery';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: `How to Get Cheap Broadway Tickets (${currentYear}) | Complete Guide`,
  description: `The ultimate guide to cheap Broadway tickets in ${currentYear}. TKTS booth, digital lotteries, rush tickets, discount codes, and insider tips to see shows for $30-50.`,
  alternates: { canonical: `${BASE_URL}/guides/cheap-broadway-tickets` },
  openGraph: {
    title: `How to Get Cheap Broadway Tickets (${currentYear})`,
    description: `Save hundreds on Broadway tickets. TKTS, lotteries, rush tickets, and more discount strategies explained.`,
    url: `${BASE_URL}/guides/cheap-broadway-tickets`,
    type: 'article',
  },
};

export default function CheapBroadwayTicketsGuide() {
  const allShows = getAllShows();
  const lotteryShowCount = getLotteryShowCount();
  const rushShowCount = getRushShowCount();

  // Get open shows with discount programs
  const openShowsWithDiscounts = allShows
    .filter(s => s.status === 'open')
    .map(show => ({
      ...show,
      lotteryRush: getLotteryRush(show.id),
    }))
    .filter(s => s.lotteryRush)
    .sort((a, b) => (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
    { name: 'Cheap Broadway Tickets', url: `${BASE_URL}/guides/cheap-broadway-tickets` },
  ]);

  // FAQ Schema for rich snippets
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'What is the cheapest way to get Broadway tickets?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Digital lotteries are the cheapest option at $30-40 for orchestra seats. Enter via TodayTix or show-specific apps. Rush tickets ($30-50) are available same-day at box offices. TKTS booths offer 20-50% off day-of tickets.',
        },
      },
      {
        '@type': 'Question',
        name: 'How does the Broadway lottery work?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Most Broadway lotteries are digital. Enter via apps like TodayTix or Lucky Seat 2-24 hours before showtime. Winners are randomly selected and can purchase 1-2 tickets at $30-40 each. You can enter multiple lotteries daily.',
        },
      },
      {
        '@type': 'Question',
        name: 'What is the TKTS booth?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'TKTS is a discount ticket booth in Times Square (and other NYC locations) selling same-day Broadway tickets at 20-50% off. Lines are longest midday; go early morning or after 7pm for shorter waits.',
        },
      },
      {
        '@type': 'Question',
        name: 'What are rush tickets?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Rush tickets are discounted same-day tickets sold at the box office when it opens (usually 10am) or online. Prices range from $30-50. First-come, first-served—arrive early for popular shows.',
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
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li><Link href="/" className="hover:text-white transition-colors">Home</Link></li>
            <li className="text-gray-500">/</li>
            <li><Link href="/guides" className="hover:text-white transition-colors">Guides</Link></li>
            <li className="text-gray-500">/</li>
            <li className="text-gray-300">Cheap Broadway Tickets</li>
          </ol>
        </nav>

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
            How to Get Cheap Broadway Tickets ({currentYear})
          </h1>
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">
            Broadway tickets can cost $150-300+ at full price, but savvy theatergoers regularly see shows for $30-50.
            This guide covers every discount strategy: digital lotteries, rush tickets, the TKTS booth, discount codes,
            and insider tips. Currently, <span className="text-brand font-semibold">{openShowsWithDiscounts.length} shows</span> offer
            lottery or rush programs.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Table of Contents */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">Jump to Section</h2>
          <ul className="space-y-2 text-sm">
            <li><a href="#lotteries" className="text-brand hover:text-brand-hover">Digital Lotteries ($30-40)</a></li>
            <li><a href="#rush" className="text-brand hover:text-brand-hover">Rush Tickets ($30-50)</a></li>
            <li><a href="#tkts" className="text-brand hover:text-brand-hover">TKTS Booth (20-50% off)</a></li>
            <li><a href="#standing-room" className="text-brand hover:text-brand-hover">Standing Room ($30-40)</a></li>
            <li><a href="#discount-codes" className="text-brand hover:text-brand-hover">Discount Codes & Apps</a></li>
            <li><a href="#shows" className="text-brand hover:text-brand-hover">Shows with Discount Programs</a></li>
          </ul>
        </div>

        {/* Digital Lotteries Section */}
        <section id="lotteries" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🎰</span> Digital Lotteries
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">The cheapest option:</strong> Digital lotteries offer orchestra seats for $30-40—tickets that normally cost $150-300+.
              Most Broadway shows now run digital lotteries through apps, making it easy to enter from anywhere.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">How Broadway Lotteries Work</h3>
              <ol className="text-gray-300 space-y-2 list-decimal list-inside">
                <li><strong className="text-white">Download the app:</strong> Most shows use <a href="https://www.todaytix.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover">TodayTix</a>, <a href="https://lottery.broadwaydirect.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover">Broadway Direct</a>, or <a href="https://www.luckyseat.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover">Lucky Seat</a></li>
                <li><strong className="text-white">Enter early:</strong> Lotteries typically open 24-48 hours before showtime</li>
                <li><strong className="text-white">Wait for results:</strong> Winners notified 2-4 hours before curtain</li>
                <li><strong className="text-white">Purchase quickly:</strong> You usually have 30-60 minutes to complete your purchase</li>
              </ol>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">💡 Pro Tips</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>• Enter multiple lotteries daily to increase your chances</li>
                <li>• Weekday matinees have better odds than Saturday nights</li>
                <li>• Some shows allow entering for 1 or 2 tickets—requesting 1 may improve odds</li>
                <li>• Set calendar reminders so you don&apos;t forget to enter</li>
                <li>• Currently <strong className="text-white">{lotteryShowCount} shows</strong> offer digital lotteries</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Rush Tickets Section */}
        <section id="rush" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🏃</span> Rush Tickets
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">First-come, first-served:</strong> Rush tickets are discounted same-day tickets sold at the box office or online.
              Unlike lotteries, you&apos;re guaranteed a ticket if you&apos;re early enough—no luck required.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Types of Rush</h3>
              <div className="space-y-3 text-gray-300">
                <div>
                  <strong className="text-white">In-Person Rush:</strong> Line up at the box office when it opens (usually 10am).
                  Popular shows may require arriving 1-2 hours early. Limit 1-2 tickets per person.
                </div>
                <div>
                  <strong className="text-white">Digital Rush:</strong> Some shows release rush tickets online at a specific time (often 10am).
                  Check TodayTix or the show&apos;s website. Faster than waiting in line but sells out quickly.
                </div>
                <div>
                  <strong className="text-white">Student Rush:</strong> Discounts for students with valid ID.
                  Some shows offer these at the box office; others require verification through apps.
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">💡 Pro Tips</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>• Check each show&apos;s specific rush policy—times and prices vary</li>
                <li>• Bring cash for in-person rush (some shows are cash-only)</li>
                <li>• Weekday mornings have shorter lines than weekends</li>
                <li>• Currently <strong className="text-white">{rushShowCount} shows</strong> offer rush tickets</li>
              </ul>
            </div>
          </div>
        </section>

        {/* TKTS Section */}
        <section id="tkts" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🎟️</span> TKTS Booth
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              The iconic TKTS booth in Times Square sells same-day Broadway tickets at 20-50% off face value.
              It&apos;s run by the Theatre Development Fund (TDF), a non-profit dedicated to making theater accessible.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">TKTS Locations & Hours</h3>
              <div className="space-y-4 text-gray-300 text-sm">
                <div>
                  <strong className="text-white block">Times Square (Red Steps)</strong>
                  Broadway & 47th St, under the red steps<br/>
                  <span className="text-gray-400">Evening: Mon-Sat 3pm-8pm, Sun 3pm-7pm</span><br/>
                  <span className="text-gray-400">Matinee: Wed & Sat 10am-2pm, Sun 11am-3pm</span>
                </div>
                <div>
                  <strong className="text-white block">Lincoln Center</strong>
                  61 W 62nd St (inside David Rubenstein Atrium)<br/>
                  <span className="text-gray-400">Tue-Sat 12pm-7pm, Sun 12pm-6pm</span><br/>
                  <span className="text-emerald-400 text-xs">💡 Usually shorter lines than Times Square</span>
                </div>
                <div>
                  <strong className="text-white block">Brooklyn (Downtown)</strong>
                  1 MetroTech Center<br/>
                  <span className="text-gray-400">Tue-Sat 11am-6pm</span><br/>
                  <span className="text-emerald-400 text-xs">💡 Sells next-day matinee tickets too</span>
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">💡 Pro Tips</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>• Download the <a href="https://www.tdf.org/nyc/81/TKTS-Background" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover">TKTS app</a> to see what&apos;s available before you line up</li>
                <li>• Arrive right when it opens or after 7pm for shorter waits</li>
                <li>• Hit shows like Hamilton and Wicked rarely appear—focus on newer productions</li>
                <li>• Lincoln Center location often has the same shows with shorter lines</li>
                <li>• Accepts credit cards but charges a $6 service fee per ticket</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Standing Room Section */}
        <section id="standing-room" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🧍</span> Standing Room Only (SRO)
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              When a show sells out, some theaters release Standing Room Only tickets for $30-40.
              You&apos;ll stand at the back of the orchestra during the performance—but for a sold-out hit, it&apos;s worth it.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">How SRO Works</h3>
              <ul className="text-gray-300 space-y-2">
                <li><strong className="text-white">Availability:</strong> Only sold when performance is sold out</li>
                <li><strong className="text-white">When to buy:</strong> Usually day-of at the box office when it opens</li>
                <li><strong className="text-white">Where you&apos;ll stand:</strong> Back of orchestra, behind last row of seats</li>
                <li><strong className="text-white">What to bring:</strong> Comfortable shoes—you&apos;ll be standing 2-3 hours</li>
              </ul>
            </div>

            <p className="text-gray-400 text-sm">
              <Link href="/standing-room" className="text-brand hover:text-brand-hover">
                See all shows with standing room options →
              </Link>
            </p>
          </div>
        </section>

        {/* Discount Codes Section */}
        <section id="discount-codes" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">📱</span> Discount Codes & Apps
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Beyond lotteries and rush, several apps and services offer Broadway discounts:
            </p>

            <div className="space-y-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">TodayTix</h3>
                <p className="text-gray-300 text-sm mb-2">
                  The essential Broadway app. Hosts most digital lotteries, plus flash sales and last-minute discounts.
                  Free to download—just create an account.
                </p>
                <a href="https://www.todaytix.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover text-sm">
                  Download TodayTix →
                </a>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Playbill Discounts</h3>
                <p className="text-gray-300 text-sm mb-2">
                  Playbill.com maintains a list of current Broadway discount codes.
                  Shows like Wicked sometimes offer codes for specific performances.
                </p>
                <a href="https://www.playbill.com/discounts" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover text-sm">
                  Browse Playbill Discounts →
                </a>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Broadway Direct / Lucky Seat</h3>
                <p className="text-gray-300 text-sm mb-2">
                  These services host lotteries for shows not on TodayTix.
                  Hamilton uses its own lottery through the Hamilton app.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">AAA / AARP / Union Discounts</h3>
                <p className="text-gray-300 text-sm">
                  Members of AAA, AARP, unions, and some credit cards get access to exclusive Broadway discounts.
                  Check your membership benefits before buying full price.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Shows with Discount Programs */}
        <section id="shows" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-6">
            Shows with Lottery or Rush Programs
          </h2>

          <div className="space-y-4">
            {openShowsWithDiscounts.map((show) => {
              const lr = show.lotteryRush!;
              return (
                <div key={show.id} className="card p-4 sm:p-5">
                  <div className="flex items-start gap-3 sm:gap-4">
                    {/* Thumbnail */}
                    <Link href={`/show/${show.slug}`} className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0 block">
                      <ShowImage
                        sources={[
                          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
                          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
                        ]}
                        alt={show.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        fallback={
                          <div className="w-full h-full flex items-center justify-center bg-surface-overlay text-gray-600 text-xl font-bold">
                            {show.title.charAt(0)}
                          </div>
                        }
                      />
                    </Link>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/show/${show.slug}`}
                        className="font-bold text-white text-base hover:text-brand transition-colors"
                      >
                        {show.title}
                      </Link>
                      <p className="text-gray-400 text-xs sm:text-sm truncate">{show.venue}</p>

                      {/* Discount badges */}
                      <div className="flex flex-wrap gap-2 mt-2">
                        {lr.lottery && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-500/15 text-purple-400 border border-purple-500/20">
                            🎰 ${lr.lottery.price} Lottery
                          </span>
                        )}
                        {lr.rush && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20">
                            🏃 ${lr.rush.price} Rush
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Score */}
                    <ScoreBadge
                      score={show.criticScore?.score}
                      size="md"
                      reviewCount={show.criticScore?.reviewCount}
                      status={show.status}
                    />
                  </div>

                  {/* Details */}
                  <div className="mt-3 pt-3 border-t border-white/5 text-sm text-gray-400">
                    {lr.lottery && (
                      <p className="mb-1">
                        <strong className="text-gray-300">Lottery:</strong> {lr.lottery.platform} • {lr.lottery.time}
                        {lr.lottery.url && (
                          <> • <a href={lr.lottery.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-hover">Enter lottery →</a></>
                        )}
                      </p>
                    )}
                    {lr.rush && (
                      <p>
                        <strong className="text-gray-300">Rush:</strong> {lr.rush.type} • {lr.rush.time}
                        {lr.rush.instructions && <> • {lr.rush.instructions}</>}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Related Pages */}
        <div className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-white/10 space-y-6">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-white mb-3">Related Pages</h3>
            <div className="flex flex-wrap gap-2">
              <Link href="/lotteries" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                All Lotteries
              </Link>
              <Link href="/rush" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                All Rush Tickets
              </Link>
              <Link href="/standing-room" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                Standing Room
              </Link>
              <Link href="/best-value" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                Best Value Shows
              </Link>
              <Link href="/guides/best-broadway-shows" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                Best Broadway Shows
              </Link>
            </div>
          </div>
        </div>

        {/* Methodology Link */}
        <div className="mt-8 text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
