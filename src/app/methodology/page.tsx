import Link from 'next/link';
import { Metadata } from 'next';
import { marketAlternates, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import { BuyMeACoffeeWidget } from '@/components/BuyMeACoffeeWidget';
import { getLegendEntries } from '@/config/commercial';
import { FIZZLE_MIN_RETURNED_PCT } from '../../../scripts/lib/commercial-designations';
import { methodologyOutletList } from '@/lib/methodology-tiers';

// Static OG image (API routes don't work with static export)
const ogImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  title: 'How It Works - Scoring Methodology',
  description: 'How Broadway Scorecard turns critic reviews and audience ratings into one score per show: which critics count, how much each one counts, and how a review becomes a number.',
  alternates: marketAlternates('broadway', '/methodology'),
  openGraph: {
    title: 'How Broadway Scorecard Works',
    description: 'Where our critic and audience scores come from, in plain English.',
    url: `${BASE_URL}/methodology`,
    type: 'article',
    images: [{
      url: ogImageUrl,
      width: 1200,
      height: 630,
      alt: 'How Broadway Scorecard Works - Scoring Methodology',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'How Broadway Scorecard Works',
    description: 'Where our critic and audience scores come from, in plain English.',
    images: [{
      url: ogImageUrl,
      width: 1200,
      height: 630,
      alt: 'How Broadway Scorecard Works - Scoring Methodology',
    }],
  },
};

// Article Schema - helps AI systems understand this as authoritative content
const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'How Broadway Scorecard Calculates Show Scores',
  description: 'How Broadway Scorecard turns professional critic reviews and audience ratings into one score per Broadway show.',
  author: {
    '@type': 'Organization',
    name: 'Broadway Scorecard',
    url: BASE_URL,
  },
  publisher: {
    '@type': 'Organization',
    name: 'Broadway Scorecard',
    url: BASE_URL,
    logo: {
      '@type': 'ImageObject',
      url: `${BASE_URL}/logo.png`,
    },
  },
  datePublished: '2024-01-01',
  dateModified: '2026-10-09',
  mainEntityOfPage: {
    '@type': 'WebPage',
    '@id': `${BASE_URL}/methodology`,
  },
  about: [
    { '@type': 'Thing', name: 'Broadway theater' },
    { '@type': 'Thing', name: 'Theater criticism' },
    { '@type': 'Thing', name: 'Review aggregation' },
  ],
};

// FAQ Schema for rich snippets in search results
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How are Broadway show scores calculated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'We give every professional review a score out of 100, then average them. Bigger outlets count for more: a New York Times review counts in full, while a personal blog counts a fifth as much.',
      },
    },
    {
      '@type': 'Question',
      name: 'What critics are included in the scores?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Every professional review we can find, from The New York Times, Vulture, Variety and The Guardian down to small theater sites and independent bloggers. Outlets sit in four tiers, and the tier decides how much a review counts.',
      },
    },
    {
      '@type': 'Question',
      name: 'How often are scores updated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Whenever a new review comes in. For a new show we keep adding reviews for the first few weeks after opening night.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the score ranges mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '83 and up is Critical Gold: drop everything and see it. 75 to 82 is Recommended, 65 to 74 is Worth Seeing, 55 to 64 is Mixed, and below 55 is a Critical Miss. West End shows need 85 for Critical Gold, because British critics nearly always give star ratings and those run high. A show reads TBD until it has 5 reviews (3 for Off-Broadway, Off-West End, tours and regional shows).',
      },
    },
    {
      '@type': 'Question',
      name: 'What is AudienceGrade?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'AudienceGrade is a letter grade, A+ to F, built from what theatergoers say on Show Score, Mezzanine, Theatr, Broadway.com and r/Broadway (plus SeatPlan, London Box Office and London Theatre Direct for London shows). Sites with more ratings count for more, and no single site can make up more than 80% of the grade. From Reddit we only count people who saw the show.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where does the box office data come from?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Broadway League publishes official grosses every week, and we take them from BroadwayWorld each Tuesday morning: the week\'s gross, how full the theater was, the average ticket price, and running totals for the whole run.',
      },
    },
  ],
};

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="text-brand">•</span>
      <span>{children}</span>
    </li>
  );
}

export default function MethodologyPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([articleSchema, faqSchema]) }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <Link href="/" className="text-brand hover:text-brand-hover text-sm mb-4 inline-flex items-center gap-1 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to shows
        </Link>
        <h1 className="text-3xl sm:text-4xl font-bold text-white mt-4">How It Works</h1>
        <p className="text-gray-400 mt-2">
          Where our numbers come from, in plain English.
        </p>
      </div>

      {/* Table of Contents */}
      <nav className="flex flex-wrap gap-2 mb-6 text-xs" aria-label="Page sections">
        <a href="#overview" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">The short version</a>
        <a href="#score-interpretation" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">What scores mean</a>
        <a href="#critic-score" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">CriticScore</a>
        <a href="#normalization" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Reviews into numbers</a>
        <a href="#audience-grade" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">AudienceGrade</a>
        {featureFlags.boxOffice && <a href="#box-office-data" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Box Office</a>}
        {featureFlags.commercial && <a href="#commercial" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Investment Data</a>}
        {featureFlags.videoReviews && <a href="#video-reviews" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">VideoScore</a>}
        {featureFlags.awardScoreV2 && <a href="#award-score" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Award Score</a>}
        <a href="#transparency" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Check our work</a>
      </nav>

      <div className="space-y-6">
        {/* Overview */}
        <section id="overview" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">The short version</h2>
          <p className="text-gray-300 mb-4">
            We read every professional review of a show, give each one a score out of 100, and average them. Reviews from bigger outlets like The New York Times count for more than reviews from small blogs. That average is the CriticScore.
          </p>
          <p className="text-gray-300">
            We do something similar with ratings from theatergoers on sites like Show Score and Mezzanine, which gives the AudienceGrade. The two are kept separate, so you can see when critics and audiences disagree.
          </p>
        </section>

        {/* Score Labels */}
        <section id="score-interpretation" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">What the scores mean</h2>
          <div className="space-y-4 sm:space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-must-see flex items-center justify-center font-bold text-sm flex-shrink-0">83+</div>
              <div>
                <span className="text-white font-medium">Critical Gold™</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">Drop everything. If you see one show, make it this one.</span>
                <span className="text-gray-500 block text-xs mt-0.5">West End shows need 85, because British critics nearly always give stars and stars run high.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-great flex items-center justify-center font-bold text-sm flex-shrink-0">75-82</div>
              <div>
                <span className="text-white font-medium">Recommended</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">A strong pick. Most people will have a great time.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-good flex items-center justify-center font-bold text-sm flex-shrink-0">65-74</div>
              <div>
                <span className="text-white font-medium">Worth Seeing</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">Good, with some reservations. Best if the story or the cast is your thing.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-tepid flex items-center justify-center font-bold text-sm flex-shrink-0">55-64</div>
              <div>
                <span className="text-white font-medium">Mixed</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">Critics are split. Worth a look if the premise grabs you.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-skip flex items-center justify-center font-bold text-sm flex-shrink-0">&lt;55</div>
              <div>
                <span className="text-white font-medium">Critical Miss</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">Most critics didn&apos;t like it. Save your time and money.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg bg-surface-overlay border border-white/10 flex items-center justify-center font-bold text-gray-400 text-sm flex-shrink-0">TBD</div>
              <div>
                <span className="text-white font-medium">Not enough reviews yet</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">We wait for 5 reviews (3 for Off-Broadway, Off-West End, tours and regional shows) before showing a score.</span>
              </div>
            </div>
          </div>
          <p className="text-gray-400 text-sm mt-4">
            If every review so far comes from smaller outlets (Tier 3 or 4, below), we wait for 2 more before showing a score.
          </p>
        </section>

        {/* Critic Score */}
        <section id="critic-score" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">How CriticScore™ works</h2>
          <p className="text-gray-300 mb-4">
            Each review gets a score out of 100 (the next section explains how). The CriticScore is the average of those scores, but not every review counts the same. A review in The New York Times reaches far more readers than a post on a personal blog, so we sort outlets into four tiers, and the tier decides how much a review counts. You&apos;ll see the tier as a small T1 to T4 label next to each outlet name.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">The four tiers</h3>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                <span className="text-xs text-gray-400">counts in full</span>
              </div>
              <p className="text-gray-300 text-sm">
                The outlets theater people read first. In New York: {methodologyOutletList('nyc', 1)}. In London: {methodologyOutletList('london', 1)}.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs font-medium">Tier 2</span>
                <span className="text-xs text-gray-400">counts 75%</span>
              </div>
              <p className="text-gray-300 text-sm">
                Established theater sites and major papers that review theater less often. In New York, for example: {methodologyOutletList('nyc', 2)}. In London: {methodologyOutletList('london', 2)}.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-400 text-xs font-medium">Tier 3</span>
                <span className="text-xs text-gray-400">counts 40%</span>
              </div>
              <p className="text-gray-300 text-sm">
                Smaller theater sites and independent critics with a track record, such as Front Mezz Junkies, The Komisar Scoop, Pages on Stages and Broadway &amp; Me. Any outlet we haven&apos;t looked at closely yet starts here too.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-500 text-xs font-medium">Tier 4</span>
                <span className="text-xs text-gray-400">counts 20%</span>
              </div>
              <p className="text-gray-300 text-sm">
                Personal blogs we haven&apos;t been able to vet. We still count them, just at a fifth of the weight of a Tier 1 review.
              </p>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Top critics</h3>
          <p className="text-gray-300 text-sm">
            A handful of critics count in full wherever they publish, because readers follow them from outlet to outlet: Jesse Green, Ben Brantley, Charles Isherwood, David Rooney, Hilton Als, Helen Shaw, Peter Marks, Elisabeth Vincentelli, Adam Feldman, Linda Winer, Alexis Soloski, Sara Holdren, Johnny Oleksinski and Chris Jones.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">New York and London are rated separately</h3>
          <p className="text-gray-300 text-sm">
            An outlet can matter more in one city than the other. The New York Times is Tier 1 for Broadway but Tier 2 for the West End, where it reviews only a few shows. The Stage is the reverse. Off-Broadway shows use the New York tiers and Off-West End shows use the London ones.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Critics&apos; Picks</h3>
          <p className="text-gray-300 text-sm">
            A New York Times Critics&apos; Pick adds 3 points to that review&apos;s score, and a Critics&apos; Pick never scores below 70. A Time Out Critics&apos; Choice adds 2 points. We only count these when the label appears on the outlet&apos;s own page.
          </p>
        </section>

        {/* Rating Normalization */}
        <section id="normalization" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">How a review becomes a number</h2>

          <h3 className="text-base font-semibold text-white mt-2 mb-3">Reviews with stars or a grade</h3>
          <p className="text-gray-300 text-sm mb-3">
            When a critic gives stars, the stars set the range and we read the review to place it within that range. A rave and a grudging four stars shouldn&apos;t get the same number.
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">5 out of 5 stars</div><div className="text-gray-300">91 to 100</div>
              <div className="text-gray-400">4 out of 5 stars</div><div className="text-gray-300">71 to 90</div>
              <div className="text-gray-400">3 out of 5 stars</div><div className="text-gray-300">51 to 70</div>
              <div className="text-gray-400">2 out of 5 stars</div><div className="text-gray-300">31 to 50</div>
            </div>
          </div>
          <p className="text-gray-300 text-sm mt-3">
            Letter grades, like Entertainment Weekly&apos;s, work the same way: an A lands near the top, a C near the middle.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Reviews with no rating</h3>
          <p className="text-gray-300 text-sm">
            Most Broadway critics don&apos;t give stars or grades at all. For those reviews, AI models read the full text and decide where it falls, from a rave to a pan. We check their work against hundreds of reviews that did come with stars.
          </p>
        </section>

        {/* Audience Buzz */}
        <section id="audience-grade" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">AudienceGrade™</h2>
          <p className="text-gray-300 mb-4">
            The AudienceGrade is what theatergoers think, collected from the sites where they rate shows and turned into a single letter grade.
          </p>

          <div className="space-y-2">
            {[
              { grade: 'A+', color: '#22c55e', desc: 'Audiences love it' },
              { grade: 'A', color: '#16a34a', desc: 'Audiences love it' },
              { grade: 'A-', color: '#14b8a6', desc: 'Audiences really like it' },
              { grade: 'B+', color: '#0ea5e9', desc: 'Audiences like it' },
              { grade: 'B', color: '#f59e0b', desc: 'Mostly positive' },
              { grade: 'B-', color: '#f97316', desc: 'Mixed' },
              { grade: 'C+', color: '#ef4444', desc: 'More doubts than praise' },
              { grade: 'C', color: '#dc2626', desc: 'Many people are disappointed' },
              { grade: 'C-', color: '#b91c1c', desc: 'Most people are disappointed' },
              { grade: 'D', color: '#991b1b', desc: 'Audiences mostly dislike it' },
              { grade: 'F', color: '#6b7280', desc: 'Audiences dislike it' },
            ].map(g => (
              <div key={g.grade} className="flex items-center gap-3">
                <span
                  className="inline-flex items-center justify-center w-9 h-6 rounded text-xs font-bold flex-shrink-0"
                  style={{ color: g.color, backgroundColor: `${g.color}20` }}
                >
                  {g.grade}
                </span>
                <span className="text-gray-400 text-sm">{g.desc}</span>
              </div>
            ))}
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Where the ratings come from</h3>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-yellow-400">★</span>
                <span className="text-white font-medium">Show Score</span>
              </div>
              <p className="text-gray-300 text-sm">
                A review site where theatergoers rate shows. Scores run from 0 to 100%.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-purple-400">🎭</span>
                <span className="text-white font-medium">Mezzanine</span>
              </div>
              <p className="text-gray-300 text-sm">
                A theater fan app with star ratings and written reviews.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-teal-400">👍</span>
                <span className="text-white font-medium">Theatr</span>
              </div>
              <p className="text-gray-300 text-sm">
                People vote that they liked a show, disliked it, or had mixed feelings. The score is the share who liked it, and we wait for at least 10 votes.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-blue-400">⭐</span>
                <span className="text-white font-medium">Broadway.com</span>
              </div>
              <p className="text-gray-300 text-sm">
                Star ratings from people who bought tickets there.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-orange-400">💬</span>
                <span className="text-white font-medium">Reddit (r/Broadway)</span>
              </div>
              <p className="text-gray-300 text-sm">
                What people on r/Broadway say after seeing a show. We only count people who actually went, so boycotts, opinions about the source material, and secondhand takes are left out. We wait until there are at least 50 comments from the last three years.
              </p>
            </div>
          </div>
          <p className="text-gray-300 text-sm mt-3">
            For London shows we also use ratings from SeatPlan, London Box Office and London Theatre Direct.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">How the sites are combined</h3>
          <p className="text-gray-300 text-sm">
            A site with more ratings for a show counts for more. No single site can make up more than 80% of a grade, so one busy site can&apos;t drown out the rest.
          </p>
        </section>

        {/* Box Office Data */}
        {featureFlags.boxOffice && <section id="box-office-data" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Box Office</h2>
          <p className="text-gray-300 mb-4">
            Every week The Broadway League publishes official ticket sales for each show. We take those figures from BroadwayWorld on Tuesday morning, after the week ends on Sunday.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">This week</h3>
          <p className="text-gray-300 text-sm mb-3">
            For shows that are running, we show:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              <Bullet>How much the show took in, and how that compares with last week and the same week last year</Bullet>
              <Bullet>How full the theater was</Bullet>
              <Bullet>The average price people paid for a ticket</Bullet>
              <Bullet>How many people saw it, and how many performances there were</Bullet>
            </ul>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">The whole run</h3>
          <p className="text-gray-300 text-sm">
            For every show, including ones that have closed, we keep running totals: total ticket sales, total performances and total audience.
          </p>
        </section>}

        {/* Investment / commercial data (BRO-4623). Linked from /biz, /biz/season and the show-page Commercial Scorecard. */}
        {featureFlags.commercial && (
        <section id="commercial" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Investment Data</h2>
          <p className="text-gray-300 text-sm mb-4">
            The Investment Tracker and each show&apos;s Commercial Scorecard mix two things: facts that have been reported publicly, and our own estimates. Every estimate is labelled, and we never present one as a reported figure.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Reported facts</h3>
          <ul className="text-gray-300 space-y-2 text-sm">
            <Bullet>
              <strong className="text-white">Recouped.</strong> We only mark a show as recouped when a trade paper or an SEC filing reports it, and we link the source. A few long-running hits never announced a date. Those say &quot;Not publicly announced&quot;, and calling them recouped is our judgment, not a reported fact.
            </Bullet>
            <Bullet>
              <strong className="text-white">Capitalization</strong> (what it cost to put the show up) comes from SEC filings and trade press. When no figure has been published we say &quot;Undisclosed&quot;, and totals say how many shows are missing, for example &quot;~$40M+&quot; with &quot;3 of 9 undisclosed&quot;. We never count an unknown figure as zero.
            </Bullet>
            <Bullet>
              <strong className="text-white">Return to investors</strong> only appears when a source reports it. We don&apos;t publish our own guesses at investor returns.
            </Bullet>
            <Bullet>
              <strong className="text-white">Weekly grosses</strong> are The Broadway League&apos;s figures, as published by Playbill and BroadwayWorld.
            </Bullet>
          </ul>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Estimates</h3>
          <p className="text-gray-300 text-sm mb-3">
            A <strong className="text-white">~</strong> before a number means it&apos;s an estimate. Our estimates compare what a show takes in each week with what it costs to run each week and what it cost to put up.
          </p>
          <ul className="text-gray-300 space-y-2 text-sm">
            <Bullet>
              <strong className="text-white">Estimated % recouped</strong> only appears for shows without a final outcome (still running, or closed and Undisclosed), and only when we have enough data. It always comes with a low and a high figure.
            </Bullet>
            <Bullet>
              <strong className="text-white">Break-even</strong> is what a show needs to take in each week to cover its running costs. When no running cost has been published we use a typical figure for a show of that size, marked with ~.
            </Bullet>
            <Bullet>
              <strong className="text-white">Weekly cost</strong> without a ~ comes from the source named under it. With a ~, it&apos;s a typical figure or an analyst&apos;s published estimate. Anything we can&apos;t cite gets a ~.
            </Bullet>
            <Bullet>
              <strong className="text-white">Approaching recoupment</strong> lists running shows that are at least 50% recouped even on our cautious estimate. <strong className="text-white">At risk</strong> lists running shows that have taken in less than break-even over the last 4 weeks and are under 30% recouped even on our hopeful estimate.
            </Bullet>
            <Bullet>
              <strong className="text-white">Trend</strong> compares the last 4 weeks of sales with the 4 weeks before.
            </Bullet>
            <Bullet>
              <strong className="text-white">Weeks to recoup</strong> counts from opening night to the reported recoupment date. If only the month was reported we use the middle of the month. If only the year was reported we leave it blank.
            </Bullet>
          </ul>
          <p className="text-gray-400 text-xs mt-3">
            Once a show closes with a known outcome, we stop showing estimates and show only the outcome and the facts behind it. A closed show whose outcome was never announced is marked Undisclosed, and any estimate shown for it is labelled as one.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Outcome labels</h3>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              {getLegendEntries().map((entry) => (
                <li key={entry.name} className="flex items-start gap-2">
                  <span className={`${entry.color} font-semibold shrink-0`}>{entry.name}</span>
                  <span className="text-gray-400">{entry.description}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            {`Unless a source reports what investors got back, the line between Fizzle and Flop (about ${FIZZLE_MIN_RETURNED_PCT}% returned) is our estimate.`}
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">How often it updates</h3>
          <p className="text-gray-300 text-sm mb-3">
            Weekly grosses update every Tuesday after the League reports. We check the trade press every hour for recoupment and closing news, and rerun the estimates once a week. The Investment Tracker shows when each was last updated.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Corrections</h3>
          <p className="text-gray-300 text-sm">
            If a figure is wrong or a source is missing, please{' '}
            <Link href="/feedback" className="text-brand hover:text-brand-hover underline">
              tell us
            </Link>{' '}
            under &quot;Content Error&quot; with a link to the source. We fix reported facts as soon as we can check them.
          </p>
        </section>
        )}

        {/* VideoScore — Video Reviews */}
        {featureFlags.videoReviews && (
        <section id="video-reviews" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">VideoScore™ <span className="text-sm font-normal text-gray-400">Beta</span></h2>
          <p className="text-gray-300 text-sm mb-4">
            Some of the most-followed theater critics now review on TikTok and YouTube instead of in print. VideoScore covers a small group of them, about ten people who regularly review Broadway and Off-Broadway shows.
          </p>
          <h3 className="text-base font-semibold text-white mt-4 mb-3">How it works</h3>
          <p className="text-gray-300 text-sm mb-4">
            When one of them posts a review, we take the video&apos;s captions and an AI model reads them to judge whether the reviewer liked the show, had mixed feelings, or didn&apos;t like it. That becomes a score out of 100 using the same labels as the CriticScore, from Critical Gold to Critical Miss.
          </p>
          <h3 className="text-base font-semibold text-white mt-6 mb-3">Keep in mind</h3>
          <ul className="text-gray-300 space-y-2 text-sm">
            <Bullet>These scores are our reading of what the creator said. The creator didn&apos;t pick the number.</Bullet>
            <Bullet>It&apos;s a small group, so each VideoScore rests on only a few reviews.</Bullet>
            <Bullet>Automatic captions can mishear accents, music or people talking over each other, which can throw a score off.</Bullet>
            <Bullet>VideoScore is shown on its own and doesn&apos;t change a show&apos;s CriticScore.</Bullet>
          </ul>
        </section>
        )}

        {/* Award Score (Awards Scorecard methodology) */}
        {featureFlags.awardScoreV2 && (
        <section id="award-score" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Award Score</h2>
          <p className="text-gray-300 text-sm mb-4">
            The <strong className="text-white">Award Score</strong> sums up a show&apos;s awards in one number out of 100. It sits next to the CriticScore and the AudienceGrade on each show&apos;s Awards Scorecard.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Which awards count</h3>
          <p className="text-gray-300 text-sm mb-3">
            For Broadway: the <strong className="text-white">Tony Awards, the Pulitzer Prize for Drama, the Drama Desk, Outer Critics Circle and Drama League awards, the New York Drama Critics&apos; Circle</strong>, and the Olivier Awards when a show transfers from London. For the West End, the Oliviers are the main event and count for more.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Bigger awards count for more</h3>
          <p className="text-gray-300 text-sm mb-3">
            A Tony for Best Musical counts for far more than a Tony for Lighting Design. Here&apos;s what a Tony win is worth in each group. A nomination is worth about a tenth of a win.
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-white/5">
                  <th className="pb-2 pr-3 font-semibold">Group</th>
                  <th className="pb-2 pr-3 font-semibold">Examples</th>
                  <th className="pb-2 font-semibold tabular-nums">Tony win</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-amber-400">S</td>
                  <td className="py-2 pr-3">Best Musical, Best Play, Best Revival, the Pulitzer</td>
                  <td className="py-2 tabular-nums">+200</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-violet-300">A+</td>
                  <td className="py-2 pr-3">Best Score, Best Book, Lyrics</td>
                  <td className="py-2 tabular-nums">+90</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-emerald-400">A</td>
                  <td className="py-2 pr-3">Best Direction, Lead Actor and Actress</td>
                  <td className="py-2 tabular-nums">+75</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-teal-400">B</td>
                  <td className="py-2 pr-3">Featured Actor and Actress, Choreography, Orchestrations, Ensemble</td>
                  <td className="py-2 tabular-nums">+35</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-semibold text-gray-400">C</td>
                  <td className="py-2 pr-3">Scenic, Costume, Lighting and Sound Design</td>
                  <td className="py-2 tabular-nums">+25</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            Other awards use the same groups at a smaller scale (a Drama Desk for Best Musical is worth +28, not +200). Revivals get 85% of the points a new show would. When one show sweeps several design awards in the same night, each one after the first counts for a little less.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">From points to a score out of 100</h3>
          <p className="text-gray-300 text-sm mb-3">
            Each extra award adds a little less than the one before, so a single win and a record-breaking sweep both fit on the same 0 to 100 scale. Roughly:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 text-sm space-y-1.5 tabular-nums">
              <li>One win in a smaller category scores about <strong className="text-white">25</strong></li>
              <li>A Pulitzer finalist with a few Tony nominations scores about <strong className="text-white">55</strong></li>
              <li>Several major Tony wins score about <strong className="text-white">84</strong></li>
              <li>A historic sweep scores <strong className="text-white">95 to 100</strong></li>
            </ul>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Badges</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-amber-500 text-amber-950 font-bold flex items-center justify-center text-xs">90+</div><div><span className="text-amber-400 font-semibold">Sweeper</span> <span className="text-gray-500">A historic haul of awards</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-emerald-500 text-white font-bold flex items-center justify-center text-xs">70-89</div><div><span className="text-emerald-400 font-semibold">Decorated</span> <span className="text-gray-500">Several major wins</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-teal-600 text-white font-bold flex items-center justify-center text-xs">1 win+</div><div><span className="text-teal-400 font-semibold">Honored</span> <span className="text-gray-500">At least one win</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-amber-700/70 text-amber-50 font-bold flex items-center justify-center text-xs">0 wins</div><div><span className="text-amber-300 font-semibold">Nominated</span> <span className="text-gray-500">Nominated, no wins yet</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-white/10 text-gray-400 font-bold flex items-center justify-center text-xs">&ndash;</div><div><span className="text-gray-400 font-semibold">Eligible</span> <span className="text-gray-500">No nominations yet</span></div></div>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            During Tony season a show&apos;s score is marked <strong className="text-amber-300">Provisional</strong> until the ceremony in June, when the wins come in.
          </p>
        </section>
        )}

        {/* Transparency */}
        <section id="transparency" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Check our work</h2>
          <p className="text-gray-300 text-sm mb-4">
            Every review behind a score is listed on the show&apos;s page, with the outlet, its tier, the score we gave it, and a link to read the full review. The same rules apply to every show.
          </p>
          <p className="text-gray-300 text-sm">
            Think we got a review or an outlet wrong?{' '}
            <Link href="/feedback" className="text-brand hover:text-brand-hover underline">
              Let us know
            </Link>.
          </p>
        </section>

        {/* Buy Me a Coffee */}
        <BuyMeACoffeeWidget />

        {/* Version */}
        <div className="text-center text-gray-500 text-sm pt-4">
          <p>Methodology version 2.3 · Last updated October 2026</p>
        </div>
      </div>
      </div>
    </>
  );
}
