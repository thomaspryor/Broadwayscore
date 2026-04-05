import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows, getOffBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: `Off-Broadway vs Broadway: What's the Difference? (${currentYear}) | Guide`,
  description: `Discover the real difference between Broadway and Off-Broadway — theater size, ticket prices, locations, and what to expect. Find which is right for your next NYC theater outing.`,
  alternates: { canonical: `${BASE_URL}/guides/off-broadway-vs-broadway` },
  openGraph: {
    title: `Off-Broadway vs Broadway: What's the Difference? (${currentYear})`,
    description: `The real difference between Broadway and Off-Broadway explained — theater size, ticket prices, locations, and which is right for you.`,
    url: `${BASE_URL}/guides/off-broadway-vs-broadway`,
    type: 'article',
  },
};

export default function OffBroadwayVsBroadwayGuide() {
  const broadwayShows = getBroadwayShows();
  const offBroadwayShows = getOffBroadwayShows();

  const openBroadway = broadwayShows.filter(s => s.status === 'open').length;
  const openOffBroadway = offBroadwayShows.filter(s => s.status === 'open').length;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
    { name: 'Off-Broadway vs Broadway', url: `${BASE_URL}/guides/off-broadway-vs-broadway` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'What is the difference between Broadway and Off-Broadway?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'The main difference is theater size. Broadway theaters have 500 or more seats and are located in Manhattan\'s Theater District. Off-Broadway theaters have 100-499 seats and are spread across Manhattan and Brooklyn. Both feature professional productions with Actors\' Equity contracts.',
        },
      },
      {
        '@type': 'Question',
        name: 'Is Off-Broadway worse than Broadway?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'No. Off-Broadway is not a lesser version of Broadway — it\'s a different format. Many acclaimed productions and future Broadway hits start Off-Broadway. Shows like Hamilton, Dear Evan Hansen, and Little Shop of Horrors all began Off-Broadway. Off-Broadway often features more experimental, intimate, and critically praised work.',
        },
      },
      {
        '@type': 'Question',
        name: 'Where are Off-Broadway theaters located?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Off-Broadway theaters are spread across Manhattan and parts of Brooklyn. Common locations include Union Square, Greenwich Village, the East Village, Midtown, and the Upper West Side. Unlike Broadway\'s concentrated Theater District, Off-Broadway venues are found throughout the city.',
        },
      },
      {
        '@type': 'Question',
        name: 'Are Off-Broadway tickets cheaper?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Yes, significantly. Off-Broadway tickets typically cost $40-100, compared to $100-200+ for Broadway. Lower demand also means better seat availability and fewer sellouts.',
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
          { label: 'Off-Broadway vs Broadway' },
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
            Off-Broadway vs Broadway: What{'\u2019'}s the Difference? ({currentYear})
          </h1>
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">
            The difference between Broadway and Off-Broadway comes down to one thing: theater size.
            Not quality, not location, not talent. Right now, there are{' '}
            <span className="text-brand font-semibold">{openBroadway} Broadway shows</span> and{' '}
            <span className="text-brand font-semibold">{openOffBroadway} Off-Broadway shows</span> running
            in New York City. Here{'\u2019'}s what you need to know about each.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Quick Comparison */}
        <div className="card p-4 sm:p-5 mb-8 bg-surface-overlay">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">At a Glance</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-2 pr-4"></th>
                  <th className="text-left py-2 pr-4">Broadway</th>
                  <th className="text-left py-2 pr-4">Off-Broadway</th>
                  <th className="text-left py-2">Off-Off-Broadway</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-medium text-white">Seats</td>
                  <td className="py-2 pr-4">500+</td>
                  <td className="py-2 pr-4">100-499</td>
                  <td className="py-2">Under 100</td>
                </tr>
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-medium text-white">Ticket Price</td>
                  <td className="py-2 pr-4">$100-200+</td>
                  <td className="py-2 pr-4">$40-100</td>
                  <td className="py-2">$10-30</td>
                </tr>
                <tr className="border-b border-gray-800">
                  <td className="py-2 pr-4 font-medium text-white">Location</td>
                  <td className="py-2 pr-4">Theater District</td>
                  <td className="py-2 pr-4">All over Manhattan</td>
                  <td className="py-2">Citywide</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-medium text-white">Equity Actors</td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2 pr-4">Yes</td>
                  <td className="py-2">Sometimes</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Table of Contents */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">Jump to Section</h2>
          <ul className="space-y-2 text-sm">
            <li><a href="#the-simple-difference" className="text-brand hover:text-brand-hover">The Simple Difference</a></li>
            <li><a href="#where-they-are" className="text-brand hover:text-brand-hover">Where They Are</a></li>
            <li><a href="#what-youll-see" className="text-brand hover:text-brand-hover">What You{'\u2019'}ll See</a></li>
            <li><a href="#ticket-prices" className="text-brand hover:text-brand-hover">Ticket Prices</a></li>
            <li><a href="#the-experience" className="text-brand hover:text-brand-hover">The Experience</a></li>
            <li><a href="#which-should-you-choose" className="text-brand hover:text-brand-hover">Which Should You Choose?</a></li>
            <li><a href="#faq" className="text-brand hover:text-brand-hover">FAQ</a></li>
          </ul>
        </div>

        {/* The Simple Difference */}
        <section id="the-simple-difference" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            The Simple Difference
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">It{'\u2019'}s about theater size, not quality.</strong> The terms
              Broadway, Off-Broadway, and Off-Off-Broadway are defined by the number of seats in
              the theater, not by the caliber of the production.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">The Official Definitions</h3>
              <div className="space-y-3 text-gray-300">
                <div>
                  <strong className="text-white">Broadway:</strong> 500 or more seats. These are the large,
                  iconic theaters most people picture when they think of New York theater. There are 41
                  Broadway theaters, almost all located in Midtown Manhattan.
                </div>
                <div>
                  <strong className="text-white">Off-Broadway:</strong> 100 to 499 seats. Professional
                  theaters with Actors{'\u2019'} Equity contracts, smaller venues, and often more adventurous
                  programming. Currently tracking{' '}
                  <span className="text-brand font-semibold">{openOffBroadway} open shows</span> on
                  Broadway Scorecard.
                </div>
                <div>
                  <strong className="text-white">Off-Off-Broadway:</strong> Under 100 seats. The most
                  experimental tier. Showcases, workshops, and emerging artists. Minimal budgets, maximum
                  creative freedom.
                </div>
              </div>
            </div>

            <p className="text-gray-300 leading-relaxed">
              All three categories refer to professional theater in New York City. A show playing in
              a 200-seat theater in the West Village is Off-Broadway regardless of how good it
              is. A show in a 1,500-seat Theater District house is Broadway regardless of its
              reviews.
            </p>
          </div>
        </section>

        {/* Where They Are */}
        <section id="where-they-are" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Where They Are
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">Broadway is concentrated. Off-Broadway is everywhere.</strong>
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Broadway Theaters</h3>
              <p className="text-gray-300 text-sm">
                Nearly all 41 Broadway theaters are clustered in the Theater District, roughly
                between 41st and 54th Streets, from 6th Avenue to 8th Avenue. This is the stretch
                of Midtown Manhattan most tourists know best. The Vivian Beaumont at Lincoln Center
                (65th St) is a notable exception.
              </p>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Off-Broadway Theaters</h3>
              <p className="text-gray-300 text-sm mb-3">
                Off-Broadway venues are spread across Manhattan and into Brooklyn. You{'\u2019'}ll find
                them in neighborhoods that feel nothing like Times Square:
              </p>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li><strong className="text-white">Union Square / East Village:</strong> Classic Theatre, New World Stages area venues</li>
                <li><strong className="text-white">Greenwich Village:</strong> Lucille Lortel Theatre, Cherry Lane Theatre, Minetta Lane Theatre</li>
                <li><strong className="text-white">Midtown (off the main drag):</strong> New World Stages, MCC Theater, Manhattan Theatre Club spaces</li>
                <li><strong className="text-white">Upper West Side:</strong> Lincoln Center{'\u2019'}s Claire Tow Theater, Mitzi E. Newhouse</li>
                <li><strong className="text-white">Brooklyn:</strong> St. Ann{'\u2019'}s Warehouse (DUMBO), BAM Harvey Theater</li>
              </ul>
            </div>

            <p className="text-gray-300 leading-relaxed text-sm mb-4">
              This geographic spread is part of the appeal. Seeing an Off-Broadway show often means
              exploring a different neighborhood, grabbing dinner somewhere you wouldn{'\u2019'}t otherwise
              visit, and experiencing a side of New York beyond the Theater District.
            </p>

            <div className="bg-brand/10 border border-brand/20 rounded-lg p-4">
              <p className="text-sm text-gray-300">
                <strong className="text-white">See it on a map:</strong>{' '}
                Our <Link href="/broadway-theaters-map" className="text-brand hover:text-brand-hover underline">interactive Broadway theater map</Link> shows
                the exact location of every Broadway theater in the Theater District.
              </p>
            </div>
          </div>
        </section>

        {/* What You'll See */}
        <section id="what-youll-see" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            What You{'\u2019'}ll See
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">Broadway favors spectacle. Off-Broadway favors risk.</strong> This
              is a generalization, but a useful one.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Broadway Tends Toward</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>Big-budget musicals with elaborate sets and costumes</li>
                <li>Revivals of classic shows (proven audience draw)</li>
                <li>Star-driven casts (film and TV actors making their stage debut)</li>
                <li>Adaptations of movies, books, and jukebox catalogs</li>
                <li>Long-running hits that become tourist staples</li>
              </ul>
            </div>

            <div className="card p-4 sm:p-5 mb-4">
              <h3 className="font-bold text-white mb-3">Off-Broadway Tends Toward</h3>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li>New works by emerging playwrights and composers</li>
                <li>Smaller casts and more intimate staging</li>
                <li>Experimental formats (immersive theater, solo shows, devised work)</li>
                <li>Edgier subject matter and more diverse stories</li>
                <li>Limited runs that create a sense of urgency</li>
              </ul>
            </div>

            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">Broadway Hits That Started Off-Broadway</h3>
              <p className="text-gray-300 text-sm mb-2">
                Many of the biggest Broadway shows in history began as Off-Broadway productions,
                where they were developed and refined before transferring to larger houses:
              </p>
              <ul className="text-gray-300 space-y-1 text-sm">
                <li><strong className="text-white">Hamilton</strong> (Public Theater, 2015)</li>
                <li><strong className="text-white">Dear Evan Hansen</strong> (Second Stage, 2016)</li>
                <li><strong className="text-white">Little Shop of Horrors</strong> (Orpheum Theatre, 1982)</li>
                <li><strong className="text-white">Rent</strong> (New York Theatre Workshop, 1996)</li>
                <li><strong className="text-white">Spring Awakening</strong> (Atlantic Theater Company, 2006)</li>
                <li><strong className="text-white">Fun Home</strong> (Public Theater, 2013)</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Ticket Prices */}
        <section id="ticket-prices" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Ticket Prices
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">Off-Broadway is significantly cheaper.</strong> This is one of
              the biggest practical differences for theatergoers.
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-yellow-400">$100-200+</div>
                  <div className="text-gray-400 text-sm">Broadway average</div>
                  <div className="text-gray-500 text-xs mt-1">Premium seats can exceed $300</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-400">$40-100</div>
                  <div className="text-gray-400 text-sm">Off-Broadway average</div>
                  <div className="text-gray-500 text-xs mt-1">Many shows under $75</div>
                </div>
              </div>
            </div>

            <p className="text-gray-300 leading-relaxed mb-4">
              Lower ticket prices are partly a function of economics. Off-Broadway theaters have fewer
              seats to fill, lower operating costs, and smaller casts, which translates to lower prices
              for audiences. The lower demand also means you{'\u2019'}re more likely to get the seats you
              want, even for popular shows.
            </p>

            <p className="text-gray-300 leading-relaxed">
              If you{'\u2019'}re looking for ways to save on Broadway tickets specifically, check out our{' '}
              <Link href="/guides/cheap-broadway-tickets" className="text-brand hover:text-brand-hover">
                complete guide to cheap Broadway tickets
              </Link>, covering lotteries, rush tickets, TKTS, and more.
            </p>
          </div>
        </section>

        {/* The Experience */}
        <section id="the-experience" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            The Experience
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">Different sizes create different experiences.</strong> Neither
              is objectively better, but they feel genuinely different.
            </p>

            <div className="space-y-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Broadway: The Grand Scale</h3>
                <p className="text-gray-300 text-sm">
                  Broadway theaters seat 500 to 1,900+ people. Productions have large budgets for
                  sets, lighting, sound, and special effects. The experience can be awe-inspiring in
                  its scale: a full orchestra, elaborate set changes, and the shared energy of a
                  packed house. The trade-off is distance. Unless you{'\u2019'}re in the first few rows,
                  you{'\u2019'}re watching from farther away.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Off-Broadway: The Intimate Connection</h3>
                <p className="text-gray-300 text-sm">
                  In a 150-seat theater, you might be 10 feet from the performers. You can see
                  facial expressions, hear unmiked voices, feel the energy directly. This intimacy
                  changes the relationship between audience and performer. The storytelling can be
                  more nuanced, the emotional impact more immediate. Many theatergoers who{'\u2019'}ve
                  experienced both prefer this closeness.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Both Are Professional</h3>
                <p className="text-gray-300 text-sm">
                  Both Broadway and Off-Broadway feature professional actors working under Actors{'\u2019'} Equity
                  Association contracts. The talent level is comparable. Many actors move between
                  Broadway and Off-Broadway throughout their careers. Directors, designers, and
                  playwrights do the same.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Which Should You Choose */}
        <section id="which-should-you-choose" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Which Should You Choose?
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              It depends on what you{'\u2019'}re looking for.
            </p>

            <div className="space-y-4">
              <div className="card p-4 sm:p-5 border border-brand/20 bg-brand/5">
                <h3 className="font-bold text-brand mb-2">First Visit to NYC?</h3>
                <p className="text-gray-300 text-sm">
                  Start with Broadway. The scale and spectacle of a big Broadway production is a
                  quintessential New York experience. Pick a highly rated show and enjoy the full
                  Theater District atmosphere.
                </p>
                <Link href="/guides/best-broadway-shows" className="text-brand hover:text-brand-hover text-sm mt-2 inline-block">
                  See the best Broadway shows right now →
                </Link>
              </div>

              <div className="card p-4 sm:p-5 border border-brand/20 bg-brand/5">
                <h3 className="font-bold text-brand mb-2">Returning Theatergoer?</h3>
                <p className="text-gray-300 text-sm">
                  Off-Broadway is where the most exciting new work happens. If you{'\u2019'}ve seen the
                  major Broadway productions and want something fresh, surprising, or more intimate,
                  this is where to look.
                </p>
                <Link href="/browse/best-off-broadway-shows" className="text-brand hover:text-brand-hover text-sm mt-2 inline-block">
                  Browse the best Off-Broadway shows →
                </Link>
              </div>

              <div className="card p-4 sm:p-5 border border-brand/20 bg-brand/5">
                <h3 className="font-bold text-brand mb-2">Budget-Conscious?</h3>
                <p className="text-gray-300 text-sm">
                  Off-Broadway gives you more theater for less money. At $40-100 per ticket, you
                  could see two or three Off-Broadway shows for the price of one Broadway ticket.
                  The quality is professional, the experience is intimate, and the value is hard to
                  beat.
                </p>
                <Link href="/browse/best-off-broadway-musicals" className="text-brand hover:text-brand-hover text-sm mt-2 inline-block">
                  Best Off-Broadway musicals →
                </Link>
              </div>

              <div className="card p-4 sm:p-5 border border-brand/20 bg-brand/5">
                <h3 className="font-bold text-brand mb-2">Why Not Both?</h3>
                <p className="text-gray-300 text-sm">
                  The best approach for a multi-day trip: see a Broadway show for the spectacle and
                  an Off-Broadway show for the discovery. You{'\u2019'}ll get the full range of what New
                  York theater has to offer.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Frequently Asked Questions
          </h2>
          <div className="space-y-4">
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">What is the difference between Broadway and Off-Broadway?</h3>
              <p className="text-gray-300 text-sm">
                The difference is theater size. Broadway theaters have 500+ seats and are located in
                Manhattan{'\u2019'}s Theater District. Off-Broadway theaters have 100-499 seats and are found
                throughout Manhattan and Brooklyn. Both feature professional actors and productions.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Is Off-Broadway worse than Broadway?</h3>
              <p className="text-gray-300 text-sm">
                Not at all. Off-Broadway is a different format, not a lesser one. Some of the most
                critically acclaimed theater in New York happens Off-Broadway. Hamilton, Rent, Dear
                Evan Hansen, and Little Shop of Horrors all started Off-Broadway before transferring.
                The smaller scale often allows for more creative risk-taking and more intimate
                performances.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Where are Off-Broadway theaters located?</h3>
              <p className="text-gray-300 text-sm">
                Off-Broadway theaters are spread across New York City, primarily in Manhattan
                neighborhoods like Greenwich Village, the East Village, Union Square, Midtown, and
                the Upper West Side. Some venues are also in Brooklyn (DUMBO, Fort Greene). Unlike
                Broadway{'\u2019'}s concentrated Theater District, Off-Broadway takes you to different
                parts of the city.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Are Off-Broadway tickets cheaper?</h3>
              <p className="text-gray-300 text-sm">
                Yes. Off-Broadway tickets typically range from $40-100, compared to $100-200+ for
                Broadway. The smaller theaters have lower operating costs, which keeps prices down.
                You{'\u2019'}re also more likely to find good seats available without planning weeks in
                advance.
              </p>
            </div>
          </div>
        </section>

        {/* Related Links */}
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-4">
            Explore More
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link href="/off-broadway" className="card p-4 hover:bg-surface-hover transition-colors group">
              <div className="font-medium text-white group-hover:text-brand transition-colors">Off-Broadway Scorecard</div>
              <div className="text-gray-400 text-sm">Scores for every Off-Broadway show</div>
            </Link>
            <Link href="/browse/best-off-broadway-shows" className="card p-4 hover:bg-surface-hover transition-colors group">
              <div className="font-medium text-white group-hover:text-brand transition-colors">Best Off-Broadway Shows</div>
              <div className="text-gray-400 text-sm">Top-rated Off-Broadway productions</div>
            </Link>
            <Link href="/browse/best-off-broadway-musicals" className="card p-4 hover:bg-surface-hover transition-colors group">
              <div className="font-medium text-white group-hover:text-brand transition-colors">Best Off-Broadway Musicals</div>
              <div className="text-gray-400 text-sm">Highest-rated Off-Broadway musicals</div>
            </Link>
            <Link href="/guides/best-broadway-shows" className="card p-4 hover:bg-surface-hover transition-colors group">
              <div className="font-medium text-white group-hover:text-brand transition-colors">Best Broadway Shows</div>
              <div className="text-gray-400 text-sm">Our guide to must-see Broadway</div>
            </Link>
            <Link href="/guides/cheap-broadway-tickets" className="card p-4 hover:bg-surface-hover transition-colors group">
              <div className="font-medium text-white group-hover:text-brand transition-colors">Cheap Broadway Tickets</div>
              <div className="text-gray-400 text-sm">Lotteries, rush, TKTS, and more</div>
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
