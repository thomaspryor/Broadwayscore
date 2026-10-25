import Link from 'next/link';
import { Metadata } from 'next';
import { marketAlternates, BASE_URL } from '@/lib/seo';
import { BuyMeACoffeeWidget } from '@/components/BuyMeACoffeeWidget';
import { methodologyOutletList } from '@/lib/methodology-tiers';

// Static OG image (API routes don't work with static export)
const ogImageUrl = `${BASE_URL}/og/west-end.png`;

export const metadata: Metadata = {
  title: { absolute: 'How It Works | West End Scorecard Methodology' },
  description:
    'How West End Scorecard turns critic reviews and audience ratings into one score per London show: which critics count, how much each one counts, and how a review becomes a number.',
  alternates: marketAlternates('westEnd', '/methodology'),
  openGraph: {
    title: 'How West End Scorecard Works',
    description: 'Where our critic and audience scores for London theatre come from, in plain English.',
    url: `${BASE_URL}/west-end/methodology`,
    type: 'article',
    siteName: 'West End Scorecard',
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: 'How West End Scorecard Works: Scoring Methodology',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'How West End Scorecard Works',
    description: 'Where our critic and audience scores for London theatre come from, in plain English.',
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: 'How West End Scorecard Works: Scoring Methodology',
      },
    ],
  },
};

// Article Schema: helps AI systems understand this as authoritative content
const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'How West End Scorecard Calculates Show Scores',
  description:
    'How West End Scorecard turns professional critic reviews and audience ratings into one score per London theatre show.',
  author: {
    '@type': 'Organization',
    name: 'West End Scorecard',
    url: `${BASE_URL}/west-end`,
  },
  publisher: {
    '@type': 'Organization',
    name: 'West End Scorecard',
    url: `${BASE_URL}/west-end`,
    logo: {
      '@type': 'ImageObject',
      url: `${BASE_URL}/logo.png`,
    },
  },
  datePublished: '2025-01-01',
  dateModified: '2026-10-09',
  mainEntityOfPage: {
    '@type': 'WebPage',
    '@id': `${BASE_URL}/west-end/methodology`,
  },
  about: [
    { '@type': 'Thing', name: 'West End theatre' },
    { '@type': 'Thing', name: 'London theatre' },
    { '@type': 'Thing', name: 'Theatre criticism' },
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
      name: 'How are West End show scores calculated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'We give every professional review a score out of 100, then average them. Bigger outlets count for more: a review in The Guardian or The Times counts in full, while a personal blog counts a fifth as much.',
      },
    },
    {
      '@type': 'Question',
      name: 'What critics are included in the scores?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Every professional review we can find, from The Guardian, The Times, The Telegraph, the Evening Standard and The Stage down to small theatre sites and independent bloggers. Outlets sit in four tiers, and the tier decides how much a review counts.',
      },
    },
    {
      '@type': 'Question',
      name: 'How often are scores updated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Whenever a new review comes in. For a new show we keep adding reviews for the first few weeks after press night.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the score ranges mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '85 and up is Critical Gold: drop everything and see it. 75 to 84 is Recommended, 65 to 74 is Worth Seeing, 55 to 64 is Mixed, and below 55 is a Critical Miss. The bar for Critical Gold is higher than on Broadway (83) because British critics nearly always give star ratings, and stars run high. A show reads TBD until it has 5 reviews (3 for Off-West End).',
      },
    },
    {
      '@type': 'Question',
      name: 'What is AudienceGrade?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'AudienceGrade is a letter grade, A+ to F, built from what theatregoers say on SeatPlan, London Box Office, London Theatre Direct, Mezzanine, Show Score and r/TheWestEnd. Sites with more ratings count for more, and no single site can make up more than 80% of the grade.',
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

const AUDIENCE_SOURCES: Array<{ icon: string; iconClass: string; name: string; desc: string }> = [
  { icon: '🎟️', iconClass: 'text-sky-400', name: 'SeatPlan', desc: 'A London ticket and seating site where theatregoers rate shows.' },
  { icon: '★', iconClass: 'text-yellow-400', name: 'London Box Office', desc: 'Star ratings from theatregoers on the London Box Office ticket site.' },
  { icon: '⭐', iconClass: 'text-blue-400', name: 'London Theatre Direct', desc: 'Star ratings from theatregoers on the London Theatre Direct ticket site.' },
  { icon: '🎭', iconClass: 'text-purple-400', name: 'Mezzanine', desc: 'A theatre fan app with star ratings and written reviews.' },
  { icon: '★', iconClass: 'text-amber-300', name: 'Show Score', desc: 'A review site where theatregoers rate shows.' },
  { icon: '💬', iconClass: 'text-orange-400', name: 'Reddit (r/TheWestEnd)', desc: 'What people say after seeing a show. We only count people who actually went, so boycotts, opinions about the source material, and secondhand takes are left out. We wait until there are at least 50 comments from the last three years.' },
];

export default function WestEndMethodologyPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([articleSchema, faqSchema]) }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <Link
            href="/west-end"
            className="text-brand hover:text-brand-hover text-sm mb-4 inline-flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to West End shows
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
          <a href="#transparency" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Check our work</a>
        </nav>

        <div className="space-y-6">
          {/* Overview */}
          <section id="overview" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">The short version</h2>
            <p className="text-gray-300 mb-4">
              We read every professional review of a London show, give each one a score out of 100, and average them. Reviews from bigger outlets like The Guardian count for more than reviews from small blogs. That average is the CriticScore.
            </p>
            <p className="text-gray-300">
              We do something similar with ratings from theatregoers on ticket sites and fan apps, which gives the AudienceGrade. The two are kept separate, so you can see when critics and audiences disagree. Broadway and the West End use the same 0 to 100 scale, so you can compare a London show with a New York one.
            </p>
          </section>

          {/* Score Labels */}
          <section id="score-interpretation" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">What the scores mean</h2>
            <div className="space-y-4 sm:space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="w-14 h-10 rounded-lg score-must-see flex items-center justify-center font-bold text-sm flex-shrink-0">85+</div>
                <div>
                  <span className="text-white font-medium">Critical Gold™</span>
                  <span className="text-gray-500 block sm:inline sm:ml-2">Drop everything. If you see one show, make it this one.</span>
                  <span className="text-gray-500 block text-xs mt-0.5">The bar is higher than on Broadway (83), because British critics nearly always give stars and stars run high.</span>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="w-14 h-10 rounded-lg score-great flex items-center justify-center font-bold text-sm flex-shrink-0">75-84</div>
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
                  <span className="text-gray-500 block sm:inline sm:ml-2">We wait for 5 reviews (3 for Off-West End) before showing a score.</span>
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
              Each review gets a score out of 100 (the next section explains how). The CriticScore is the average of those scores, but not every review counts the same. A review in The Guardian reaches far more readers than a post on a personal blog, so we sort outlets into four tiers, and the tier decides how much a review counts. You&apos;ll see the tier as a small T1 to T4 label next to each outlet name.
            </p>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">The four tiers</h3>
            <div className="space-y-3">
              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                  <span className="text-xs text-gray-400">counts in full</span>
                </div>
                <p className="text-gray-300 text-sm">
                  The papers and magazines theatre people read first: {methodologyOutletList('london', 1)}.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs font-medium">Tier 2</span>
                  <span className="text-xs text-gray-400">counts 75%</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Established theatre sites, plus New York outlets when they review a London show. For example: {methodologyOutletList('london', 2)}.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-surface text-gray-400 text-xs font-medium">Tier 3</span>
                  <span className="text-xs text-gray-400">counts 40%</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Smaller theatre sites and independent critics with a track record. Any outlet we haven&apos;t looked at closely yet starts here too.
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

            <h3 className="text-base font-semibold text-white mt-6 mb-3">London and New York are rated separately</h3>
            <p className="text-gray-300 text-sm">
              An outlet can matter more in one city than the other. Most British papers are Tier 1 for London shows but Tier 2 for Broadway, where they review only a few shows (The Guardian is Tier 1 in both). The New York Times is the reverse. Off-West End shows use the same London tiers.
            </p>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Critics&apos; Choice</h3>
            <p className="text-gray-300 text-sm">
              A Time Out Critics&apos; Choice adds 2 points to that review&apos;s score. We only count it when the label appears on Time Out&apos;s own page.
            </p>
          </section>

          {/* Rating Normalisation */}
          <section id="normalization" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">How a review becomes a number</h2>

            <h3 className="text-base font-semibold text-white mt-2 mb-3">Reviews with stars</h3>
            <p className="text-gray-300 text-sm mb-3">
              Nearly every British critic gives stars, so most London scores start there. The stars set the range, and we read the review to place it within that range. A rave and a grudging four stars shouldn&apos;t get the same number.
            </p>
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-gray-400">5 out of 5 stars</div><div className="text-gray-300">91 to 100</div>
                <div className="text-gray-400">4 out of 5 stars</div><div className="text-gray-300">71 to 90</div>
                <div className="text-gray-400">3 out of 5 stars</div><div className="text-gray-300">51 to 70</div>
                <div className="text-gray-400">2 out of 5 stars</div><div className="text-gray-300">31 to 50</div>
              </div>
            </div>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Reviews with no stars</h3>
            <p className="text-gray-300 text-sm">
              For the few reviews without stars, AI models read the full text and decide where it falls, from a rave to a pan. We check their work against hundreds of reviews that did come with stars.
            </p>
          </section>

          {/* Audience Grade */}
          <section id="audience-grade" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">AudienceGrade™</h2>
            <p className="text-gray-300 mb-4">
              The AudienceGrade is what theatregoers think, collected from the sites where they rate shows and turned into a single letter grade.
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
              ].map((g) => (
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
              {AUDIENCE_SOURCES.map((s) => (
                <div key={s.name} className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={s.iconClass}>{s.icon}</span>
                    <span className="text-white font-medium">{s.name}</span>
                  </div>
                  <p className="text-gray-300 text-sm">{s.desc}</p>
                </div>
              ))}
            </div>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">How the sites are combined</h3>
            <p className="text-gray-300 text-sm">
              A site with more ratings for a show counts for more. No single site can make up more than 80% of a grade, so one busy site can&apos;t drown out the rest.
            </p>
          </section>

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
          <BuyMeACoffeeWidget siteName="West End Scorecard" />

          {/* Version */}
          <div className="text-center text-gray-500 text-sm pt-4">
            <p>Methodology version 2.3 · Last updated October 2026</p>
          </div>
        </div>
      </div>
    </>
  );
}
