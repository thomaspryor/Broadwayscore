import Link from 'next/link';
import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';

// Static OG image (API routes don't work with static export)
const ogImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  title: 'How It Works - Scoring Methodology',
  description: 'Learn how Broadway Scorecard calculates critic scores and Audience Buzz from aggregated reviews. Our transparent methodology uses weighted averages based on outlet tier and audience sentiment.',
  alternates: {
    canonical: `${BASE_URL}/methodology`,
  },
  openGraph: {
    title: 'How Broadway Scorecard Works',
    description: 'Our transparent scoring methodology for aggregating Broadway critic reviews and audience sentiment.',
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
    description: 'Our transparent scoring methodology for aggregating Broadway critic reviews and audience sentiment.',
    images: [{
      url: ogImageUrl,
      width: 1200,
      height: 630,
      alt: 'How Broadway Scorecard Works - Scoring Methodology',
    }],
  },
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
        text: 'Broadway Scorecard aggregates professional critic reviews and calculates a weighted average score. Reviews from major outlets like The New York Times (Tier 1) have full weight, while smaller publications have slightly reduced weights.',
      },
    },
    {
      '@type': 'Question',
      name: 'What critics are included in the scores?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'We include reviews from major publications including The New York Times, Variety, The Hollywood Reporter, Vulture, The Guardian, Time Out, and many more. Critics are organized into three tiers based on reach and influence.',
      },
    },
    {
      '@type': 'Question',
      name: 'How often are scores updated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Scores are updated as new reviews are published. For new shows, we continuously add reviews during the first few weeks after opening night.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the score ranges mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Scores of 85+ indicate "Must-See" (drop-everything great), 75-84 is "Recommended" (strong choice), 65-74 is "Worth Seeing" (good with caveats), 55-64 is "Skippable" (optional), and below 55 is "Stay Away" (not recommended). Shows with fewer than 5 reviews display "TBD" until more reviews are collected.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is Audience Buzz?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Audience Buzz aggregates theatergoer sentiment from Show Score, Mezzanine, and Reddit into four designations: Loving (88+), Liking (78-87), Shrugging (68-77), and Loathing (0-67). Sources are weighted dynamically based on sample size, with Reddit capturing buzz at 20% and Show Score/Mezzanine splitting the remaining 80% proportionally.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where does the box office data come from?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Box office data is sourced from BroadwayWorld, which aggregates official figures from The Broadway League. We automatically update weekly grosses, capacity percentages, and all-time statistics every Tuesday and Wednesday after the reporting period ends. This includes current week performance with comparisons and lifetime cumulative stats for all shows.',
      },
    },
  ],
};

export default function MethodologyPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
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
          Our methodology for aggregating and calculating Broadway show scores.
        </p>
      </div>

      <div className="space-y-6">
        {/* Overview */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Overview</h2>
          <p className="text-gray-300 mb-4">
            Broadway Scorecard is an independent review aggregator built specifically for Broadway theater. Unlike general entertainment aggregators, we focus exclusively on theatrical productions with specialized features including box office data, theater information, and opening/closing tracking.
          </p>
          <p className="text-gray-300">
            Our scoring methodology aggregates professional critic reviews using a weighted average system calibrated specifically for Broadway. Reviews are sourced from major publications and weighted by outlet tier to reflect their reach and theatrical expertise.
          </p>
        </section>

        {/* Score Labels */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Score Interpretation</h2>
          <p className="text-gray-300 mb-4">
            Critic Scores are labeled based on these thresholds:
          </p>
          <div className="space-y-4 sm:space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-must-see flex items-center justify-center font-bold text-sm flex-shrink-0">85+</div>
              <div>
                <span className="text-white font-medium">Must-See</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Drop-everything great. If you&apos;re seeing one show, make it this.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-great flex items-center justify-center font-bold text-sm flex-shrink-0">75-84</div>
              <div>
                <span className="text-white font-medium">Recommended</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Strong choice—most people will have a great time.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-good flex items-center justify-center font-bold text-sm flex-shrink-0">65-74</div>
              <div>
                <span className="text-white font-medium">Worth Seeing</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Good, with caveats. Best if the premise/cast is your thing.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-tepid flex items-center justify-center font-bold text-sm flex-shrink-0">55-64</div>
              <div>
                <span className="text-white font-medium">Skippable</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Optional. Fine to miss unless you&apos;re a completist or super fan.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-skip flex items-center justify-center font-bold text-sm flex-shrink-0">&lt;55</div>
              <div>
                <span className="text-white font-medium">Stay Away</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Not recommended—save your time and money.</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg bg-surface-overlay border border-white/10 flex items-center justify-center font-bold text-gray-400 text-sm flex-shrink-0">TBD</div>
              <div>
                <span className="text-white font-medium">To Be Determined</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Fewer than 5 reviews collected</span>
              </div>
            </div>
          </div>
        </section>

        {/* Critic Score */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Critic Score Calculation</h2>
          <p className="text-gray-300 mb-4">
            Critic scores are weighted averages based on outlet tier. Each review is assigned a score from 0-100 based on its rating or sentiment.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Outlet Tiers</h3>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                <span className="text-gray-400 text-sm">Weight: 1.0×</span>
              </div>
              <p className="text-gray-300 text-sm">
                The New York Times, Washington Post, Variety, Hollywood Reporter, Vulture, The Guardian, Time Out, Broadway News, LA Times, Wall Street Journal, AP
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-gray-500/20 text-gray-400 text-xs font-medium">Tier 2</span>
                <span className="text-gray-400 text-sm">Weight: 0.75×</span>
              </div>
              <p className="text-gray-300 text-sm">
                NY Post, NY Daily News, TheaterMania, Entertainment Weekly, Deadline, The Wrap, IndieWire, Observer, Slant, Chicago Tribune, USA Today, NY Stage Review, NY Theatre Guide
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-500 text-xs font-medium">Tier 3</span>
                <span className="text-gray-400 text-sm">Weight: 0.45×</span>
              </div>
              <p className="text-gray-300 text-sm">
                BroadwayWorld, amNewYork, Front Mezz Junkies, Culture Sauce, and other smaller outlets/blogs
              </p>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Designation Bumps</h3>
          <p className="text-gray-300 text-sm mb-3">
            Special designations add bonus points to a review&apos;s base score:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">NYT Critics&apos; Pick</div>
              <div className="text-brand">+3 points</div>
              <div className="text-gray-400">Time Out Critics&apos; Choice</div>
              <div className="text-brand">+2 points</div>
              <div className="text-gray-400">Recommended / Pick</div>
              <div className="text-brand">+2 points</div>
            </div>
          </div>
        </section>

        {/* Rating Normalization */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Rating Normalization</h2>
          <p className="text-gray-300 mb-4">
            All ratings are normalized to a 0–100 scale for comparability.
          </p>

          <h3 className="text-base font-semibold text-white mt-4 mb-3">Star Ratings</h3>
          <p className="text-gray-300 text-sm mb-2">
            Converted using: <code className="bg-surface-overlay px-2 py-1 rounded text-brand">(stars / max_stars) × 100</code>
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5 mt-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">5/5 stars</div><div className="text-gray-300">100</div>
              <div className="text-gray-400">4/5 stars</div><div className="text-gray-300">80</div>
              <div className="text-gray-400">3.5/5 stars</div><div className="text-gray-300">70</div>
              <div className="text-gray-400">3/5 stars</div><div className="text-gray-300">60</div>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Letter Grades</h3>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500 mb-1">A Range</div>
                <div className="text-gray-300">A+ = 100</div>
                <div className="text-gray-300">A = 95</div>
                <div className="text-gray-300">A- = 90</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">B Range</div>
                <div className="text-gray-300">B+ = 85</div>
                <div className="text-gray-300">B = 80</div>
                <div className="text-gray-300">B- = 75</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">C Range</div>
                <div className="text-gray-300">C+ = 70</div>
                <div className="text-gray-300">C = 65</div>
                <div className="text-gray-300">C- = 60</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">D/F Range</div>
                <div className="text-gray-300">D+ = 55</div>
                <div className="text-gray-300">D = 50</div>
                <div className="text-gray-300">F = 30</div>
              </div>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Sentiment Buckets</h3>
          <p className="text-gray-300 text-sm mb-3">
            When a review has no explicit rating, we categorize based on sentiment:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">Rave</div><div className="text-score-high">90</div>
              <div className="text-gray-400">Positive</div><div className="text-score-high">82</div>
              <div className="text-gray-400">Mixed-Positive</div><div className="text-score-high">72</div>
              <div className="text-gray-400">Mixed / Neutral</div><div className="text-score-medium">65</div>
              <div className="text-gray-400">Mixed-Negative</div><div className="text-score-medium">58</div>
              <div className="text-gray-400">Negative</div><div className="text-score-low">48</div>
              <div className="text-gray-400">Pan</div><div className="text-score-low">30</div>
            </div>
          </div>
        </section>

        {/* Audience Buzz */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Audience Buzz</h2>
          <p className="text-gray-300 mb-4">
            Audience Buzz captures what theatergoers are actually saying about shows, combining audience ratings from multiple platforms into a single sentiment designation.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Designations</h3>
          <p className="text-gray-300 text-sm mb-4">
            Shows are assigned one of four designations based on aggregated audience scores:
          </p>
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 w-40 flex-shrink-0">
                <span className="text-2xl">❤️</span>
                <span className="text-white font-medium">Loving</span>
              </div>
              <div className="text-gray-500 text-sm">88+ score — Audiences rave about it</div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 w-40 flex-shrink-0">
                <span className="text-2xl">👍</span>
                <span className="text-white font-medium">Liking</span>
              </div>
              <div className="text-gray-500 text-sm">78-87 score — Strong positive reception</div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 w-40 flex-shrink-0">
                <span className="text-2xl">🤷</span>
                <span className="text-white font-medium">Shrugging</span>
              </div>
              <div className="text-gray-500 text-sm">68-77 score — Mixed audience response</div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 w-40 flex-shrink-0">
                <span className="text-2xl">💩</span>
                <span className="text-white font-medium">Loathing</span>
              </div>
              <div className="text-gray-500 text-sm">0-67 score — Audiences disappointed</div>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Sources</h3>
          <p className="text-gray-300 text-sm mb-3">
            We aggregate audience sentiment from three platforms:
          </p>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-yellow-400">★</span>
                <span className="text-white font-medium">Show Score</span>
              </div>
              <p className="text-gray-300 text-sm">
                Broadway-focused review aggregator with audience ratings (0-100%)
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-purple-400">🎭</span>
                <span className="text-white font-medium">Mezzanine</span>
              </div>
              <p className="text-gray-300 text-sm">
                Theater enthusiast app with star ratings and reviews
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-orange-400">💬</span>
                <span className="text-white font-medium">Reddit (r/Broadway)</span>
              </div>
              <p className="text-gray-300 text-sm">
                Sentiment analysis of discussions and reviews from the Broadway subreddit
              </p>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Weighting Methodology</h3>
          <p className="text-gray-300 text-sm mb-3">
            Sources are weighted dynamically based on sample size to ensure reliability:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Reddit:</strong> Fixed 20% weight when available (captures buzz and enthusiasm)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Show Score & Mezzanine:</strong> Split the remaining 80% proportionally by review count</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span>Sources with more reviews receive proportionally more weight, ensuring larger sample sizes have greater influence</span>
              </li>
            </ul>
          </div>
        </section>

        {/* Box Office Data */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Box Office Data</h2>
          <p className="text-gray-300 mb-4">
            Broadway Scorecard tracks weekly box office performance and all-time statistics for every production, providing transparency into commercial success alongside critical and audience reception.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Data Source</h3>
          <p className="text-gray-300 text-sm mb-3">
            All box office data is sourced from <strong className="text-white">BroadwayWorld</strong>, which aggregates official figures reported by The Broadway League. Data is automatically scraped and updated twice weekly (Tuesdays and Wednesdays at 10 AM ET) after the weekly reporting period ends on Sunday.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">This Week Stats</h3>
          <p className="text-gray-300 text-sm mb-3">
            For currently running shows, we display current week performance with week-over-week and year-over-year comparisons:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Gross:</strong> Total box office revenue for the week, with WoW and YoY % change</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Capacity:</strong> Percentage of available seats filled, with WoW % change</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Avg Ticket Price:</strong> Average price paid per ticket for the week</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Attendance:</strong> Total number of seats filled during the week</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Performances:</strong> Number of shows performed during the week</span>
              </li>
            </ul>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">All-Time Stats</h3>
          <p className="text-gray-300 text-sm mb-3">
            For all shows (including closed productions), we track cumulative lifetime statistics:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Total Gross:</strong> Cumulative box office revenue across the entire run</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Total Performances:</strong> Total number of shows performed to date</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Total Attendance:</strong> Cumulative audience members across all performances</span>
              </li>
            </ul>
          </div>

          <p className="text-gray-300 text-sm mt-4">
            Box office data provides important context for understanding a show&apos;s commercial viability and audience appeal, complementing critical reviews and audience sentiment.
          </p>
        </section>

        {/* Confidence */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Confidence Rating</h2>
          <p className="text-gray-300 mb-4">
            Each score includes a confidence indicator based on review coverage:
          </p>

          <div className="space-y-3">
            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-high/10 border border-score-high/20">
              <span className="px-2 py-0.5 rounded bg-score-high/20 text-score-high text-xs font-medium flex-shrink-0">High</span>
              <div className="text-gray-300 text-sm">
                15+ critic reviews with 3+ from Tier 1 outlets
              </div>
            </div>

            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-medium/10 border border-score-medium/20">
              <span className="px-2 py-0.5 rounded bg-score-medium/20 text-score-medium text-xs font-medium flex-shrink-0">Medium</span>
              <div className="text-gray-300 text-sm">
                6–14 critic reviews with at least 1 Tier 1 outlet
              </div>
            </div>

            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-low/10 border border-score-low/20">
              <span className="px-2 py-0.5 rounded bg-score-low/20 text-score-low text-xs font-medium flex-shrink-0">Low</span>
              <div className="text-gray-300 text-sm">
                Fewer than 6 critic reviews or show still in previews
              </div>
            </div>
          </div>
        </section>

        {/* What Makes Us Different */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">What Makes Broadway Scorecard Unique</h2>
          <p className="text-gray-300 mb-4">
            Unlike general entertainment aggregators, Broadway Scorecard is built exclusively for theater:
          </p>
          <ul className="text-gray-300 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span><strong className="text-white">Broadway-specific focus:</strong> Every show, every week, with specialized tracking of openings, closings, and previews</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span><strong className="text-white">Box office integration:</strong> Weekly grosses, capacity percentages, and all-time stats for every production</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span><strong className="text-white">Theater metadata:</strong> Cast, creative teams, venues, runtimes, and ticket pricing</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span><strong className="text-white">Independent methodology:</strong> Our tier weights and scoring approach are calibrated specifically for Broadway criticism</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span><strong className="text-white">Audience Buzz tracking:</strong> Aggregated audience sentiment from Show Score, Mezzanine, and Reddit discussions</span>
            </li>
          </ul>
        </section>

        {/* Transparency */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Transparency</h2>
          <p className="text-gray-300 mb-4">
            We believe in complete transparency:
          </p>
          <ul className="text-gray-300 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Every individual review is listed with its source, original rating, and mapped score</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Outlet tiers and weights are clearly documented above</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>All scoring rules are defined in our open-source codebase</span>
            </li>
          </ul>
        </section>

        {/* Version */}
        <div className="text-center text-gray-500 text-sm pt-4">
          <p>Methodology Version 2.0.0 — Last updated January 2026</p>
        </div>
      </div>
      </div>
    </>
  );
}
