import Link from 'next/link';
import { Metadata } from 'next';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: `What to Wear to Broadway (${currentYear}) | Broadway Dress Code Guide`,
  description: `Find out what to wear to a Broadway show in ${currentYear}. No official dress code — smart casual is the sweet spot. Get outfit tips for tourist trips, date nights, and opening nights.`,
  alternates: { canonical: `${BASE_URL}/guides/what-to-wear-to-broadway` },
  openGraph: {
    title: `What to Wear to a Broadway Show (${currentYear})`,
    description: `Broadway dress code guide: what most people wear, what to avoid, and tips for every occasion.`,
    url: `${BASE_URL}/guides/what-to-wear-to-broadway`,
    type: 'article',
  },
};

export default function WhatToWearToBroadwayGuide() {
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
    { name: 'What to Wear to Broadway', url: `${BASE_URL}/guides/what-to-wear-to-broadway` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'Is there a dress code for Broadway?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'No, Broadway theaters do not have an official dress code. You will see everything from jeans and sneakers to cocktail dresses. Most theatergoers dress smart casual — think nice jeans with a blouse or blazer, or a casual dress with comfortable shoes.',
        },
      },
      {
        '@type': 'Question',
        name: 'Can I wear jeans to a Broadway show?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Yes, jeans are perfectly fine for Broadway. Many theatergoers wear jeans paired with a nice top or blazer. Dark jeans with minimal distressing tend to look the most polished, but there is no rule against any style of jeans.',
        },
      },
      {
        '@type': 'Question',
        name: 'What should I wear to a Broadway matinee?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Matinees tend to be slightly more casual than evening performances. Comfortable, put-together daytime clothes work well — think a nice top with jeans or khakis, a casual dress, or a sweater with slacks. Bring a layer since theaters can be cool.',
        },
      },
      {
        '@type': 'Question',
        name: 'Do I need to dress up for Broadway?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'You do not need to dress up for Broadway, but many people enjoy the occasion to look a little nicer than their everyday wardrobe. Smart casual is the sweet spot — comfortable enough for walking around Manhattan but polished enough to feel like a night out.',
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, faqSchema, {
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: `How to Dress for a Broadway Show (${currentYear})`,
          description: 'A simple guide to choosing the right outfit for your Broadway show, from casual matinees to special occasions.',
          step: [
            { '@type': 'HowToStep', name: 'Know There Is No Dress Code', text: 'Broadway theaters have no official dress code. You will not be turned away for wearing jeans, and you will not be overdressed in a cocktail dress. Most people land somewhere in the middle.' },
            { '@type': 'HowToStep', name: 'Default to Smart Casual', text: 'A nice top with dark jeans or slacks, a casual dress, or a blazer over a simple outfit. Comfortable shoes are essential — you will walk to and from the theater.' },
            { '@type': 'HowToStep', name: 'Dress for the Occasion', text: 'Tourist trip: clean and comfortable. Date night: step it up with a dress or blazer. Opening night: this is the one time to go all out.' },
            { '@type': 'HowToStep', name: 'Prepare for the Theater', text: 'Theaters are cold — bring a light layer. Check your coat at the theater ($2-3). Wear shoes you can sit in comfortably for 2+ hours.' },
          ],
        }]) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Guides', href: '/guides' },
          { label: 'What to Wear to Broadway' },
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
            What to Wear to a Broadway Show ({currentYear})
          </h1>
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">
            Wondering what to wear to Broadway? The short answer: whatever makes you comfortable.
            There is no official dress code at any Broadway theater. Most people land somewhere between
            jeans-and-a-nice-top and cocktail attire. This guide covers what to expect,
            what to avoid, and how to dress for every occasion.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Table of Contents */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-3">Jump to Section</h2>
          <ul className="space-y-2 text-sm">
            <li><a href="#short-answer" className="text-brand hover:text-brand-hover">The Short Answer</a></li>
            <li><a href="#what-most-people-wear" className="text-brand hover:text-brand-hover">What Most People Wear</a></li>
            <li><a href="#what-to-avoid" className="text-brand hover:text-brand-hover">What to Avoid</a></li>
            <li><a href="#by-occasion" className="text-brand hover:text-brand-hover">By Occasion</a></li>
            <li><a href="#practical-tips" className="text-brand hover:text-brand-hover">Practical Tips</a></li>
            <li><a href="#by-season" className="text-brand hover:text-brand-hover">Dressing by Season</a></li>
            <li><a href="#kids" className="text-brand hover:text-brand-hover">What About Kids?</a></li>
            <li><a href="#faq" className="text-brand hover:text-brand-hover">FAQ</a></li>
          </ul>
        </div>

        {/* The Short Answer */}
        <section id="short-answer" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            The Short Answer
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              <strong className="text-white">There is no dress code for Broadway.</strong> No theater will
              turn you away for what you&apos;re wearing. On any given night, you&apos;ll see audience members in
              everything from designer suits to sneakers and graphic tees.
            </p>
            <p className="text-gray-300 leading-relaxed mb-4">
              That said, most people treat a Broadway show as a &quot;nice outing&quot; and dress a notch above
              their everyday clothes. The most common look is <strong className="text-white">smart casual</strong> &mdash;
              think nice jeans with a blouse or blazer, a casual dress, or slacks with a button-down.
            </p>
            <div className="card p-4 sm:p-5 bg-emerald-500/10 border border-emerald-500/20">
              <h3 className="font-bold text-emerald-400 mb-2">The Golden Rule</h3>
              <p className="text-gray-300 text-sm">
                Wear something you&apos;ll be comfortable sitting in for 2-3 hours and walking 10-20 minutes
                to and from the theater. Comfort beats formality every time.
              </p>
            </div>
          </div>
        </section>

        {/* What Most People Wear */}
        <section id="what-most-people-wear" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            What Most People Actually Wear
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              If you people-watched in a Broadway theater lobby, here&apos;s what you&apos;d see most often:
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-3">Common Looks</h3>
                <ul className="text-gray-300 space-y-2 text-sm">
                  <li>Dark jeans or chinos with a nice top</li>
                  <li>Blouse or button-down with slacks</li>
                  <li>Casual dress or skirt with a jacket</li>
                  <li>Blazer over a simple shirt</li>
                  <li>Sweater and dark jeans</li>
                  <li>Comfortable dress shoes, clean sneakers, or boots</li>
                </ul>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-3">You&apos;ll Also See</h3>
                <ul className="text-gray-300 space-y-2 text-sm">
                  <li>T-shirts (especially at matinees)</li>
                  <li>Sneakers and casual shoes</li>
                  <li>Shorts in summer</li>
                  <li>Full suits and cocktail dresses</li>
                  <li>Show merchandise from other productions</li>
                  <li>Tourist-casual: khakis and a polo</li>
                </ul>
              </div>
            </div>

            <p className="text-gray-300 leading-relaxed">
              The Broadway audience is genuinely diverse. You will never be the most or least dressed-up
              person in the room, no matter what you wear.
            </p>
          </div>
        </section>

        {/* What to Avoid */}
        <section id="what-to-avoid" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            What to Avoid
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Nothing is technically banned, but a few things will make <em>your</em> experience less enjoyable:
            </p>

            <div className="card p-4 sm:p-5 mb-4">
              <ul className="text-gray-300 space-y-3 text-sm">
                <li>
                  <strong className="text-white">Flip flops or very flat sandals</strong> &mdash;
                  You&apos;ll walk several blocks to and from the theater. Broadway-adjacent sidewalks are
                  crowded and uneven. Closed-toe shoes or sturdy sandals are much more practical.
                </li>
                <li>
                  <strong className="text-white">Gym clothes or athletic wear</strong> &mdash;
                  Not a rule, but you may feel underdressed sitting next to people in business casual.
                  A quick change from workout gear to jeans and a clean shirt goes a long way.
                </li>
                <li>
                  <strong className="text-white">Very bulky coats or large bags</strong> &mdash;
                  Theater seats are narrow. If you&apos;re visiting in winter, plan to check your coat &mdash;
                  most theaters offer coat check for a few dollars.
                </li>
                <li>
                  <strong className="text-white">Strong perfume or cologne</strong> &mdash;
                  You&apos;ll be sitting very close to other people for hours. Go easy on fragrances.
                </li>
                <li>
                  <strong className="text-white">Tall hats or elaborate headwear</strong> &mdash;
                  Be mindful of the person behind you. If your hat blocks sightlines, you may be asked to remove it.
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* By Occasion */}
        <section id="by-occasion" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            What to Wear by Occasion
          </h2>
          <div className="prose prose-invert max-w-none space-y-4">
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Tourist Trip or First Visit</h3>
              <p className="text-gray-300 text-sm mb-2">
                Comfort is king. You&apos;ve been walking around Manhattan all day, and that&apos;s fine.
                Clean, casual clothes work perfectly &mdash; jeans, a comfortable top, and shoes you&apos;ve
                been walking in all day. Nobody will judge you for looking like a tourist.
              </p>
              <p className="text-gray-400 text-xs">
                Suggested: Jeans or khakis, a nice t-shirt or casual button-down, comfortable walking shoes.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Date Night</h3>
              <p className="text-gray-300 text-sm mb-2">
                This is where most people step it up a notch. A Broadway show is a natural date-night
                activity, and dressing a little nicer adds to the experience. Think business casual
                or a going-out outfit &mdash; something you&apos;d wear to a nice restaurant.
              </p>
              <p className="text-gray-400 text-xs">
                Suggested: A dress or dressy separates, slacks with a blazer, nice shoes (but ones you can walk in).
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Opening Night or Special Occasion</h3>
              <p className="text-gray-300 text-sm mb-2">
                Opening nights and galas are the one time Broadway gets genuinely dressy. If you&apos;re
                attending an opening night, press event, or benefit performance, cocktail attire is
                the norm. These events often include pre- or post-show receptions.
              </p>
              <p className="text-gray-400 text-xs">
                Suggested: Cocktail dress, suit, or your best going-out look. This is the one occasion where overdressing fits right in.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Matinee</h3>
              <p className="text-gray-300 text-sm mb-2">
                Matinees are the most casual performances. The audience skews toward families, tourists,
                and regulars fitting a show into their weekend. Daytime-appropriate clothes are perfectly fine.
              </p>
              <p className="text-gray-400 text-xs">
                Suggested: Whatever you&apos;d wear to a nice brunch. Jeans, a sweater, casual dress &mdash; all fair game.
              </p>
            </div>
          </div>
        </section>

        {/* Practical Tips */}
        <section id="practical-tips" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Practical Tips
          </h2>
          <div className="prose prose-invert max-w-none">
            <div className="space-y-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Theaters Run Cold</h3>
                <p className="text-gray-300 text-sm">
                  This is the single most common complaint from first-time theatergoers.
                  Broadway theaters crank the air conditioning, even in winter (all those bodies generate heat).
                  <strong className="text-white"> Bring a light layer</strong> &mdash; a cardigan, blazer,
                  or lightweight jacket you can drape over your shoulders. You&apos;ll thank yourself by intermission.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Comfortable Shoes Matter More Than Style</h3>
                <p className="text-gray-300 text-sm">
                  Unless you&apos;re being dropped off by car, you&apos;ll walk at least 10-15 minutes each way
                  through Times Square crowds. Add in standing during intermission and navigating stairs
                  to your seats. Heels look great but can make the whole evening uncomfortable.
                  Clean sneakers or low-heeled boots are a smart choice.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Use the Coat Check</h3>
                <p className="text-gray-300 text-sm">
                  If you&apos;re visiting in fall or winter, check your coat. Most Broadway theaters
                  offer coat check for $2-4 per item. Theater seats are tight, and wrestling with a
                  puffy coat for two hours is no fun. Check it when you arrive and pick it up at intermission
                  or after the show.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Evening vs. Matinee Vibe</h3>
                <p className="text-gray-300 text-sm">
                  Evening performances tend to have a slightly dressier crowd, especially on Fridays and Saturdays.
                  Wednesday matinees and Saturday matinees are the most casual. If you&apos;re self-conscious about
                  dressing too casually, a matinee is a good bet.
                </p>
              </div>

              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Check the Weather</h3>
                <p className="text-gray-300 text-sm">
                  New York weather is unpredictable. In summer, it&apos;s hot and humid outside but freezing
                  inside the theater. In winter, you&apos;ll bundle up for the walk but want to shed layers once seated.
                  Dress in layers you can easily adjust.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Dressing by Season */}
        <section id="by-season" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Dressing by Season
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              New York City weather varies dramatically throughout the year. Here&apos;s how to dress
              for each season so you&apos;re comfortable both outside and in the theater.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Spring (March{'\u2013'}May)</h3>
                <p className="text-gray-300 text-sm">
                  Unpredictable. Can be 45{'\u00b0'}F or 75{'\u00b0'}F. Layers are essential: a light jacket
                  or cardigan you can remove once seated. Bring a small umbrella.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Summer (June{'\u2013'}August)</h3>
                <p className="text-gray-300 text-sm">
                  Hot and humid outside, aggressively air-conditioned inside. Wear something
                  cool for the walk but bring a sweater or wrap for the theater. A tank top
                  alone will leave you shivering by Act 2.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Fall (September{'\u2013'}November)</h3>
                <p className="text-gray-300 text-sm">
                  The best season for Broadway. Comfortable walking weather, easy to layer. A
                  blazer or light jacket works perfectly both outside and in the theater.
                </p>
              </div>
              <div className="card p-4 sm:p-5">
                <h3 className="font-bold text-white mb-2">Winter (December{'\u2013'}February)</h3>
                <p className="text-gray-300 text-sm">
                  Bundle up for the walk (it&apos;s cold and windy near Times Square), then check
                  your heavy coat at the theater ($2{'\u2013'}3). Wear something comfortable
                  underneath that works once the parka comes off.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* What About Kids? */}
        <section id="kids" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            What About Kids?
          </h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-gray-300 leading-relaxed mb-4">
              Don&apos;t overthink it. Kids should wear whatever they&apos;re comfortable in. A Broadway
              show is exciting enough without adding an uncomfortable outfit to the mix.
            </p>

            <div className="card p-4 sm:p-5">
              <ul className="text-gray-300 space-y-2 text-sm">
                <li>
                  <strong className="text-white">Comfort first:</strong> They&apos;ll be sitting for 2+ hours.
                  Avoid anything itchy, stiff, or restrictive.
                </li>
                <li>
                  <strong className="text-white">Layers:</strong> Kids feel the cold even more than adults.
                  Bring a hoodie or light jacket.
                </li>
                <li>
                  <strong className="text-white">Shoes they can walk in:</strong> You&apos;ll navigate
                  crowds and stairs. Skip the dress shoes if they&apos;re not broken in.
                </li>
                <li>
                  <strong className="text-white">No need to buy a special outfit:</strong> Their
                  nicest school clothes or a step up from everyday wear is plenty.
                </li>
              </ul>
            </div>

            <p className="text-gray-300 leading-relaxed mt-4">
              Planning a show with kids? Check our <Link href="/guides/best-broadway-shows-for-kids" className="text-brand hover:text-brand-hover">guide to the best Broadway shows for kids</Link> for
              age-appropriate recommendations.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">
            Frequently Asked Questions
          </h2>
          <div className="prose prose-invert max-w-none space-y-4">
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Is there a dress code for Broadway?</h3>
              <p className="text-gray-300 text-sm">
                No. Broadway theaters have no official dress code. You will not be turned away
                or refused entry based on your outfit. The norm is smart casual, but you are free
                to dress up or down as you prefer.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Can I wear jeans to a Broadway show?</h3>
              <p className="text-gray-300 text-sm">
                Absolutely. Jeans are one of the most common things you&apos;ll see in a Broadway audience.
                Pair them with a nice top or blazer and you&apos;ll fit right in. Dark jeans look a
                bit more polished, but any clean pair of jeans is fine.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">What should I wear to a Broadway matinee?</h3>
              <p className="text-gray-300 text-sm">
                Matinees are the most relaxed performances. Think nice-brunch attire: jeans or casual
                pants, a comfortable top, and shoes you can walk in. Many audience members come
                straight from sightseeing or weekend errands.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-white mb-2">Do I need to dress up for Broadway?</h3>
              <p className="text-gray-300 text-sm">
                Not at all. While some people enjoy dressing up for a night at the theater, it is
                entirely optional. The most important thing is that you&apos;re comfortable. A step above
                your everyday clothes is more than enough.
              </p>
            </div>
          </div>
        </section>

        {/* Related Pages */}
        <div className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-white/10 space-y-6">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-white mb-3">Related Guides</h3>
            <div className="flex flex-wrap gap-2">
              <Link href="/guides/best-broadway-shows-for-kids" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                Best Shows for Kids
              </Link>
              <Link href="/browse/first-time-broadway" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                First Time on Broadway
              </Link>
              <Link href="/guides/cheap-broadway-tickets" className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center">
                Cheap Broadway Tickets
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
