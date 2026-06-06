import Link from 'next/link';
import { Metadata } from 'next';
import { marketAlternates, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import { BuyMeACoffeeWidget } from '@/components/BuyMeACoffeeWidget';

// Static OG image (API routes don't work with static export)
const ogImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  title: 'How It Works - Scoring Methodology',
  description: 'Learn how Broadway Scorecard calculates CriticScore ratings and AudienceGrade from aggregated reviews. Our transparent methodology uses weighted averages based on outlet tier and audience sentiment.',
  alternates: marketAlternates('broadway', '/methodology'),
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

// Article Schema - helps AI systems understand this as authoritative content
const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'How Broadway Scorecard Calculates Show Scores',
  description: 'Learn how Broadway Scorecard aggregates professional critic reviews and audience sentiment into composite scores for Broadway shows.',
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
  dateModified: '2026-03-09',
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
        text: 'Broadway Scorecard aggregates professional critic reviews and calculates a weighted average score. Reviews from major outlets like The New York Times (Tier 1) carry more weight, reflecting their reach and theatrical expertise.',
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
        text: 'Scores of 83+ indicate "Critical Gold" (drop-everything great), 75-82 is "Recommended" (strong choice), 65-74 is "Worth Seeing" (good with caveats), 55-64 is "Skippable" (optional), and below 55 is "Critical Miss" (not recommended). West End shows require 85+ for Critical Gold because UK outlets use star ratings almost exclusively, which compresses scores toward the top. Shows with fewer than 5 reviews display "TBD" until more reviews are collected.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is AudienceGrade?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The AudienceGrade aggregates theatergoer sentiment from Show Score, Mezzanine, Theatr, Broadway.com, and Reddit (r/Broadway) into letter grades from A+ (90-100) through F (below 48). Sources are weighted dynamically based on sample size, with no single source dominating the final score. Reddit sentiment is analyzed from actual attendee comments only — boycotts, source material opinions, and secondhand takes are filtered out.',
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
          Our methodology for aggregating and calculating Broadway show scores.
        </p>
      </div>

      {/* Table of Contents */}
      <nav className="flex flex-wrap gap-2 mb-6 text-xs" aria-label="Page sections">
        <a href="#overview" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Overview</a>
        <a href="#score-interpretation" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Score Labels</a>
        <a href="#critic-score" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">CriticScore</a>
        <a href="#normalization" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Normalization</a>
        <a href="#audience-grade" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">AudienceGrade</a>
        {featureFlags.boxOffice && <a href="#box-office-data" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Box Office</a>}
        {featureFlags.videoReviews && <a href="#video-reviews" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">VideoScore</a>}
        {featureFlags.awardScoreV2 && <a href="#award-score" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Award Score</a>}
        <a href="#unique" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">What&apos;s Unique</a>
        <a href="#transparency" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Transparency</a>
      </nav>

      <div className="space-y-6">
        {/* Overview */}
        <section id="overview" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Overview</h2>
          <p className="text-gray-300 mb-4">
            Broadway Scorecard™ is an independent review aggregator built specifically for Broadway theater. Unlike general entertainment aggregators, we focus exclusively on theatrical productions with specialized features including box office data, theater information, and opening/closing tracking.
          </p>
          <p className="text-gray-300">
            Our scoring methodology aggregates professional critic reviews using a weighted average system calibrated specifically for Broadway. Reviews are sourced from major publications and weighted by outlet tier to reflect their reach and theatrical expertise.
          </p>
        </section>

        {/* Score Labels */}
        <section id="score-interpretation" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Score Interpretation</h2>
          <p className="text-gray-300 mb-4">
            CriticScore ratings are labeled based on these thresholds:
          </p>
          <div className="space-y-4 sm:space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-must-see flex items-center justify-center font-bold text-sm flex-shrink-0">83+</div>
              <div>
                <span className="text-white font-medium">Critical Gold™</span>
                <span className="text-gray-500 block sm:inline sm:ml-2">— Drop-everything great. If you&apos;re seeing one show, make it this.</span>
                <span className="text-gray-500 block text-xs mt-0.5">West End: 85+ (UK star ratings compress scores higher)</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <div className="w-14 h-10 rounded-lg score-great flex items-center justify-center font-bold text-sm flex-shrink-0">75-82</div>
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
                <span className="text-white font-medium">Critical Miss</span>
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
        <section id="critic-score" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">CriticScore™ Calculation</h2>
          <p className="text-gray-300 mb-4">
            CriticScore ratings are weighted averages based on outlet tier. Each review is assigned a score from 0-100 based on its rating or sentiment. Higher-tier outlets carry more weight, reflecting their reach and theatrical expertise.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Outlet Tiers</h3>
          <p className="text-sm text-gray-400 mb-3">
            Tiers are <strong>per-region</strong>: an outlet can be Tier 1 in one market and Tier 2 in another. Example: The New York Times is Tier 1 for Broadway shows but Tier 2 for West End shows (where it has minimal bureau coverage). The Stage is Tier 1 for West End but Tier 2 for Broadway.
          </p>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                <span className="text-xs text-gray-400">weight 1.0 · anchor outlets</span>
              </div>
              <p className="text-gray-300 text-sm">
                NYC anchors: The New York Times, Vulture, Variety, Hollywood Reporter, WSJ, Washington Post, The New Yorker, Time Out NY, Broadway News, Deadline, AP, Newsday, LA Times.
                London anchors: The Guardian (dual), Times UK, Telegraph, Standard, Financial Times, The Stage, Time Out London, Independent, Observer.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs font-medium">Tier 2</span>
                <span className="text-xs text-gray-400">weight 0.75 · major editorial</span>
              </div>
              <p className="text-gray-300 text-sm">
                NYC: TheaterMania, NYSR, BroadwayWorld, NY Theatre Guide, Theatrely, NY Daily News, NY Post, Observer (US), Theater Life, Front Row Center, NYTG, Theater Scene, Cititour, Playbill, EW, Rolling Stone, People, Newsweek, Slate, IndieWire.
                London: Daily Mail, WhatsOnStage, London Theatre, The Reviews Hub, BroadwayWorld UK, Arts Desk, British Theatre Guide, Spectator UK, Everything Theatre, Theatre Weekly.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-400 text-xs font-medium">Tier 3</span>
                <span className="text-xs text-gray-400">weight 0.40 · general coverage / single-author professional</span>
              </div>
              <p className="text-gray-300 text-sm">
                Smaller theater publications and recognized single-author critics with cross-outlet history or aggregator pickup. Includes Front Mezz Junkies (Ross), The Komisar Scoop (Lucy Komisar), Pages on Stages (Mason Pilevsky), Broadway & Me (Janice C. Simpson), and ~280 other outlets.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-500 text-xs font-medium">Tier 4</span>
                <span className="text-xs text-gray-400">weight 0.20 · unverified single-author blogs</span>
              </div>
              <p className="text-gray-300 text-sm">
                Single-author blogs without aggregator pickup or recognized-critic credentials. Counted at reduced weight rather than excluded entirely.
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-4">
            Off-Broadway and Off-West-End shows share the parent-region tier (Off-Broadway uses NYC tier; Off-West-End uses London tier).
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Designation Bumps</h3>
          <p className="text-gray-300 text-sm mb-3">
            When an outlet officially designates a review with a special label, we apply a small bonus to the review&apos;s base score. We only recognize designations that are verified from the outlet&apos;s actual page markup:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span>NYT Critics&apos; Pick</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span>Time Out Critics&apos; Choice</span>
              </li>
            </ul>
          </div>
        </section>

        {/* Rating Normalization */}
        <section id="normalization" className="card p-5 sm:p-6 scroll-mt-20">
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
          <p className="text-gray-300 text-sm">
            Letter grades from outlets like Entertainment Weekly are converted using a standard academic mapping (A+ at the top, F at the bottom), calibrated to align with our 0&ndash;100 scale.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Sentiment Analysis</h3>
          <p className="text-gray-300 text-sm">
            Most Broadway critics don&apos;t give star ratings or letter grades. When a review has no explicit rating, we use proprietary sentiment analysis to classify the full review text on a seven-point scale from Rave to Pan. The system is calibrated against hundreds of critic-scored reviews for accuracy and consistency. Each classification maps to a score on the 0&ndash;100 scale.
          </p>
        </section>

        {/* Audience Buzz */}
        <section id="audience-grade" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">AudienceGrade™</h2>
          <p className="text-gray-300 mb-4">
            The AudienceGrade captures what theatergoers are actually saying about shows, combining audience ratings from multiple platforms into a single letter grade.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Grade Scale</h3>
          <p className="text-gray-300 text-sm mb-4">
            Shows receive a letter grade based on their aggregated AudienceGrade rating:
          </p>
          <div className="space-y-2">
            {[
              { grade: 'A+', color: '#22c55e', desc: 'Audiences love it' },
              { grade: 'A', color: '#16a34a', desc: 'Audiences love it' },
              { grade: 'A-', color: '#14b8a6', desc: 'Strong audience reception' },
              { grade: 'B+', color: '#0ea5e9', desc: 'Solid audience reception' },
              { grade: 'B', color: '#f59e0b', desc: 'Mixed-positive reception' },
              { grade: 'B-', color: '#f97316', desc: 'Mixed audience reception' },
              { grade: 'C+', color: '#ef4444', desc: 'Below-average reception' },
              { grade: 'C', color: '#dc2626', desc: 'Weak audience reception' },
              { grade: 'C-', color: '#b91c1c', desc: 'Poor audience reception' },
              { grade: 'D', color: '#991b1b', desc: 'Very poor reception' },
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

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Sources</h3>
          <p className="text-gray-300 text-sm mb-3">
            We aggregate audience sentiment from five platforms:
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
                <span className="text-teal-400">👍</span>
                <span className="text-white font-medium">Theatr</span>
              </div>
              <p className="text-gray-300 text-sm">
                Broadway community app with three-way sentiment (like, dislike, mixed). Score is calculated as weighted approval: likes count fully, mixed counts half, dislikes count zero.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-blue-400">⭐</span>
                <span className="text-white font-medium">Broadway.com</span>
              </div>
              <p className="text-gray-300 text-sm">
                Star ratings (0.5-5.0) from verified ticket buyers on Broadway&apos;s largest ticket marketplace. Converted to 0-100 scale.
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-orange-400">💬</span>
                <span className="text-white font-medium">Reddit (r/Broadway)</span>
              </div>
              <p className="text-gray-300 text-sm">
                Sentiment analysis from r/Broadway discussions. Only comments from people who actually attended the show are counted &mdash; boycotts, source material opinions, and secondhand takes are filtered out.
              </p>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Weighting Methodology</h3>
          <p className="text-gray-300 text-sm">
            Sources are weighted dynamically based on sample size to ensure reliability. No single source can dominate the final score, and larger sample sizes carry proportionally more weight.
          </p>
        </section>

        {/* Box Office Data */}
        {featureFlags.boxOffice && <section id="box-office-data" className="card p-5 sm:p-6 scroll-mt-20">
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
        </section>}

        {/* VideoScore — Video Reviews */}
        {featureFlags.videoReviews && (
        <section id="video-reviews" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">VideoScore™ <span className="text-sm font-normal text-gray-400">Beta</span></h2>
          <p className="text-gray-300 text-sm mb-4">
            VideoScore aggregates opinions from a curated group of theater video critics on TikTok and YouTube. Unlike traditional text critics, these creators share their reactions and reviews through video — and we score them using AI transcript analysis.
          </p>
          <h3 className="text-base font-semibold text-white mt-4 mb-3">How it works</h3>
          <ol className="text-gray-300 space-y-2 text-sm list-decimal list-inside">
            <li>We monitor a curated list of verified video critics who regularly review Broadway and Off-Broadway shows</li>
            <li>When a creator posts a review video, we extract the transcript using platform captions</li>
            <li>The transcript is analyzed by AI (Claude) to determine the creator&apos;s overall sentiment — positive, mixed, or negative</li>
            <li>A score from 0&ndash;100 is assigned using the same bucket system as CriticScore (Critical Gold, Recommended, Worth Seeing, Skippable, Critical Miss)</li>
          </ol>
          <h3 className="text-base font-semibold text-white mt-6 mb-3">Important differences from CriticScore</h3>
          <ul className="text-gray-300 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>VideoScores are <strong className="text-white">AI-estimated</strong> from transcripts, not human-assigned ratings. They reflect the sentiment of what the creator said, not a score the creator chose.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>The creator pool is small (currently ~7 video critics) compared to 420+ text outlets. VideoScore averages are based on fewer data points.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Auto-generated captions can be imperfect, especially with accents, music, or crosstalk. This may occasionally affect score accuracy.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>VideoScore is separate from CriticScore and does not affect the composite score shown in the show header.</span>
            </li>
          </ul>
        </section>
        )}

        {/* Award Score (Awards Scorecard methodology) */}
        {featureFlags.awardScoreV2 && (
        <section id="award-score" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">Award Score</h2>
          <p className="text-gray-300 text-sm mb-4">
            The <strong className="text-white">Award Score</strong> is a 0&ndash;100 prestige rating that rolls every major theater-awards recognition into a single number. It runs alongside CriticScore (critics) and AudienceGrade (fans) on each show page&apos;s Awards Scorecard.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Ceremonies counted</h3>
          <p className="text-gray-300 text-sm mb-3">
            Broadway: <strong className="text-white">Tony Awards, Pulitzer Prize for Drama, Drama Desk, Outer Critics Circle, Drama League, NY Drama Critics&apos; Circle, Olivier</strong> (when a transfer). West End uses the Olivier as the headline ceremony with proportionally higher weights.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">How categories are weighted</h3>
          <p className="text-gray-300 text-sm mb-3">
            Every category is sorted into a tier; the tier sets the points awarded for a win. Nominations earn roughly <strong className="text-white">one-eighth to one-tenth</strong> of the same-tier win — wins dominate; nominations signal recognition but have limited score impact.
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-white/5">
                  <th className="pb-2 pr-3 font-semibold">Tier</th>
                  <th className="pb-2 pr-3 font-semibold">Examples</th>
                  <th className="pb-2 font-semibold tabular-nums">Tony win</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-amber-400">S</td>
                  <td className="py-2 pr-3">Best Musical, Best Play, Best Revival, Pulitzer Drama</td>
                  <td className="py-2 tabular-nums">+200</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-violet-300">A+</td>
                  <td className="py-2 pr-3">Best Score, Best Book, Outstanding Lyrics (×1.2 multiplier)</td>
                  <td className="py-2 tabular-nums">+90</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-emerald-400">A</td>
                  <td className="py-2 pr-3">Best Direction, Lead Actor / Actress</td>
                  <td className="py-2 tabular-nums">+75</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-2 pr-3 font-semibold text-teal-400">B</td>
                  <td className="py-2 pr-3">Featured Actor / Actress, Choreography, Orchestrations, Ensemble</td>
                  <td className="py-2 tabular-nums">+35</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-semibold text-gray-400">C</td>
                  <td className="py-2 pr-3">Scenic, Costume, Lighting, Sound Design</td>
                  <td className="py-2 tabular-nums">+25</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            Pulitzer Drama, NY Drama Critics&apos; Circle, and other ceremonies use the same tier system with proportional weights (e.g. a Drama Desk Best Musical win is +28, not +200). Revivals get an 0.85× multiplier; stacked C-tier wins (4 design categories on one show) discount after the first.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">From raw points to 0&ndash;100</h3>
          <p className="text-gray-300 text-sm mb-3">
            Raw points get log-scaled so a single Tony win and a 12-Tony sweep can sit on the same 0&ndash;100 scale used everywhere else on the site. Rough calibration:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <ul className="text-gray-300 text-sm space-y-1.5 tabular-nums">
              <li><strong className="text-white">~12</strong> raw points &nbsp;&rarr;&nbsp; <strong className="text-white">~25</strong> score &nbsp;<span className="text-gray-500">(one Featured win)</span></li>
              <li><strong className="text-white">~100</strong> raw points &nbsp;&rarr;&nbsp; <strong className="text-white">~55</strong> score &nbsp;<span className="text-gray-500">(Pulitzer finalist + a few Tony noms)</span></li>
              <li><strong className="text-white">~500</strong> raw points &nbsp;&rarr;&nbsp; <strong className="text-white">~84</strong> score &nbsp;<span className="text-gray-500">(several major Tony wins)</span></li>
              <li><strong className="text-white">~1,000+</strong> raw points &nbsp;&rarr;&nbsp; <strong className="text-white">95&ndash;100</strong> score &nbsp;<span className="text-gray-500">(historic sweep)</span></li>
            </ul>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            Revivals get an 0.85&times; multiplier (a Tony win for a revival is still a real win, but slightly less weighted than for original work). When a show has 4&ndash;6 design-category wins on the same night, the stacked C-tier wins discount after the first to avoid overweighting any single ceremony&apos;s design haul.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Tier badges</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-amber-500 text-amber-950 font-bold flex items-center justify-center text-xs">90+</div><div><span className="text-amber-400 font-semibold">Sweeper</span> <span className="text-gray-500">— historic award haul</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-emerald-500 text-white font-bold flex items-center justify-center text-xs">70-89</div><div><span className="text-emerald-400 font-semibold">Decorated</span> <span className="text-gray-500">— multiple major wins</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-teal-600 text-white font-bold flex items-center justify-center text-xs">1 win+</div><div><span className="text-teal-400 font-semibold">Honored</span> <span className="text-gray-500">— at least one win</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-amber-700/70 text-amber-50 font-bold flex items-center justify-center text-xs">0 wins</div><div><span className="text-amber-300 font-semibold">Nominated</span> <span className="text-gray-500">— recognized but yet to win</span></div></div>
            <div className="flex items-center gap-3"><div className="w-12 h-8 rounded-lg bg-white/10 text-gray-400 font-bold flex items-center justify-center text-xs">&mdash;</div><div><span className="text-gray-400 font-semibold">Eligible</span> <span className="text-gray-500">— not yet recognized</span></div></div>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            During an active Tony season, a show&apos;s score is marked <strong className="text-amber-300">Provisional</strong> until the ceremony — wins land in June and the score will climb.
          </p>
        </section>
        )}

        {/* What Makes Us Different */}
        <section id="unique" className="card p-5 sm:p-6 scroll-mt-20">
          <h2 className="text-xl font-bold text-white mb-4">What Makes Broadway Scorecard™ Unique</h2>
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
              <span><strong className="text-white">AudienceGrade:</strong> Aggregated audience sentiment from Show Score, Mezzanine, Theatr, Broadway.com, and Reddit discussions</span>
            </li>
          </ul>
        </section>

        {/* Transparency */}
        <section id="transparency" className="card p-5 sm:p-6 scroll-mt-20">
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
              <span>All scoring rules are consistently applied across every show in our database</span>
            </li>
          </ul>
        </section>

        {/* Buy Me a Coffee */}
        <BuyMeACoffeeWidget />

        {/* Version */}
        <div className="text-center text-gray-500 text-sm pt-4">
          <p>Methodology Version 2.2.0 — Last updated March 2026</p>
        </div>
      </div>
      </div>
    </>
  );
}
