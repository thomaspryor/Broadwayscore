import Link from 'next/link';
import { Metadata } from 'next';
import { marketAlternates, BASE_URL } from '@/lib/seo';
import { BuyMeACoffeeWidget } from '@/components/BuyMeACoffeeWidget';

// Static OG image (API routes don't work with static export)
const ogImageUrl = `${BASE_URL}/og/west-end.png`;

export const metadata: Metadata = {
  title: { absolute: 'How It Works — West End Scorecard Methodology' },
  description:
    'Learn how West End Scorecard calculates CriticScore ratings and AudienceGrade from aggregated London theatre reviews. Our transparent methodology uses weighted averages based on outlet tier and audience sentiment.',
  alternates: marketAlternates('westEnd', '/methodology'),
  openGraph: {
    title: 'How West End Scorecard Works',
    description:
      'Our transparent scoring methodology for aggregating West End critic reviews and audience sentiment.',
    url: `${BASE_URL}/west-end/methodology`,
    type: 'article',
    siteName: 'West End Scorecard',
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: 'How West End Scorecard Works — Scoring Methodology',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'How West End Scorecard Works',
    description:
      'Our transparent scoring methodology for aggregating West End critic reviews and audience sentiment.',
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: 'How West End Scorecard Works — Scoring Methodology',
      },
    ],
  },
};

// Article Schema — helps AI systems understand this as authoritative content
const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'How West End Scorecard Calculates Show Scores',
  description:
    'Learn how West End Scorecard aggregates professional critic reviews and audience sentiment into composite scores for London theatre shows.',
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
  dateModified: '2026-04-11',
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
        text: 'West End Scorecard aggregates professional critic reviews and calculates a weighted average score. Reviews from major outlets like The Guardian, The Times, and Evening Standard (Tier 1) carry more weight, reflecting their reach and theatrical expertise.',
      },
    },
    {
      '@type': 'Question',
      name: 'What critics are included in the scores?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'We include reviews from major UK publications including The Guardian, The Times, The Telegraph, Evening Standard, Financial Times, The Observer, The Stage, Time Out, WhatsOnStage, Broadway World UK, and many more. Critics are organized into three tiers based on reach and influence.',
      },
    },
    {
      '@type': 'Question',
      name: 'How often are scores updated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Scores are updated as new reviews are published. For new shows, we continuously add reviews during the first few weeks after press night.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the score ranges mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Scores of 85+ indicate "Critical Gold" (drop-everything great), 75-84 is "Recommended" (strong choice), 65-74 is "Worth Seeing" (good with caveats), 55-64 is "Skippable" (optional), and below 55 is "Critical Miss" (not recommended). West End shows require 85+ for Critical Gold because UK outlets use star ratings almost exclusively, which compresses scores toward the top. Shows with fewer than 5 reviews display "TBD" until more reviews are collected.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is AudienceGrade?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The AudienceGrade aggregates theatregoer sentiment from Theatr, Mezzanine, TodayTix, and Reddit discussions into letter grades from A+ (90-100) through F (below 48). Sources are weighted dynamically based on sample size, with no single source dominating the final score.',
      },
    },
  ],
};

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
            Our methodology for aggregating and calculating West End show scores.
          </p>
        </div>

        {/* Table of Contents */}
        <nav className="flex flex-wrap gap-2 mb-6 text-xs" aria-label="Page sections">
          <a href="#overview" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Overview</a>
          <a href="#score-interpretation" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Score Labels</a>
          <a href="#critic-score" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">CriticScore</a>
          <a href="#normalization" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Normalization</a>
          <a href="#audience-grade" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">AudienceGrade</a>
          <a href="#unique" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">What&apos;s Unique</a>
          <a href="#transparency" className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white transition-colors">Transparency</a>
        </nav>

        <div className="space-y-6">
          {/* Overview */}
          <section id="overview" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">Overview</h2>
            <p className="text-gray-300 mb-4">
              West End Scorecard is an independent review aggregator built specifically for London theatre. Unlike general entertainment aggregators, we focus exclusively on theatrical productions with specialised features including press night tracking, opening/closing dates, and West End venue information.
            </p>
            <p className="text-gray-300">
              Our scoring methodology aggregates professional critic reviews using a weighted average system calibrated specifically for the West End. Reviews are sourced from major UK publications and weighted by outlet tier to reflect their reach and theatrical expertise.
            </p>
          </section>

          {/* Score Labels */}
          <section id="score-interpretation" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">Score Interpretation</h2>
            <p className="text-gray-300 mb-4">
              CriticScore ratings are labelled based on these thresholds:
            </p>
            <div className="space-y-4 sm:space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="w-14 h-10 rounded-lg score-must-see flex items-center justify-center font-bold text-sm flex-shrink-0">85+</div>
                <div>
                  <span className="text-white font-medium">Critical Gold™</span>
                  <span className="text-gray-500 block sm:inline sm:ml-2">— Drop-everything great. If you&apos;re seeing one show, make it this.</span>
                  <span className="text-gray-500 block text-xs mt-0.5">West End threshold is higher than Broadway (83+) because UK star ratings compress scores.</span>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="w-14 h-10 rounded-lg score-great flex items-center justify-center font-bold text-sm flex-shrink-0">75-84</div>
                <div>
                  <span className="text-white font-medium">Recommended</span>
                  <span className="text-gray-500 block sm:inline sm:ml-2">— Strong choice — most people will have a great time.</span>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="w-14 h-10 rounded-lg score-good flex items-center justify-center font-bold text-sm flex-shrink-0">65-74</div>
                <div>
                  <span className="text-white font-medium">Worth Seeing</span>
                  <span className="text-gray-500 block sm:inline sm:ml-2">— Good, with caveats. Best if the premise or cast is your thing.</span>
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
                  <span className="text-gray-500 block sm:inline sm:ml-2">— Not recommended — save your time and money.</span>
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
              Tiers are <strong>per-region</strong>. UK national papers are Tier 1 for West End shows (their primary beat) but Tier 2 for Broadway shows (light cross-coverage). The Stage is Tier 1 in both regions when it covers them; The Guardian has a true dual-anchor presence.
            </p>
            <div className="space-y-3">
              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                  <span className="text-xs text-gray-400">weight 1.0</span>
                </div>
                <p className="text-gray-300 text-sm">
                  The Guardian, The Times (UK), The Telegraph, Evening Standard, Daily Mail, Financial Times, The Observer, i Paper, The Independent, The Stage, Time Out London.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs font-medium">Tier 2</span>
                  <span className="text-xs text-gray-400">weight 0.75</span>
                </div>
                <p className="text-gray-300 text-sm">
                  WhatsOnStage, London Theatre, The Reviews Hub, BroadwayWorld UK, Arts Desk, British Theatre Guide, Spectator UK, Everything Theatre, Theatre Weekly, London Box Office, plus NYC anchor outlets covering London (NY Times, Variety, Vulture, etc.) at reduced weight.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-surface text-gray-400 text-xs font-medium">Tier 3</span>
                  <span className="text-xs text-gray-400">weight 0.40 · general / single-author professional</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Smaller theatre publications and recognised single-author critics with cross-outlet history or aggregator pickup. Includes ~50 active London theatre outlets.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded bg-surface text-gray-500 text-xs font-medium">Tier 4</span>
                  <span className="text-xs text-gray-400">weight 0.20 · unverified blogs</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Single-author blogs without aggregator pickup or recognised critic credentials. Counted at reduced weight rather than excluded entirely.
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-4">
              Off-West-End shows share the same London tier as West End shows.
            </p>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Designation Bumps</h3>
            <p className="text-gray-300 text-sm mb-3">
              When an outlet officially designates a review with a special label, we apply a small bonus to the review&apos;s base score. We only recognise designations that are verified from the outlet&apos;s actual page markup:
            </p>
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <ul className="text-gray-300 space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <span className="text-brand">•</span>
                  <span>Time Out Critics&apos; Choice</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand">•</span>
                  <span>WhatsOnStage Editor&apos;s Pick</span>
                </li>
              </ul>
            </div>
          </section>

          {/* Rating Normalisation */}
          <section id="normalization" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">Rating Normalisation</h2>
            <p className="text-gray-300 mb-4">
              All ratings are normalised to a 0–100 scale for comparability.
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
            <p className="text-gray-300 text-sm mt-3">
              The vast majority of UK theatre critics publish star ratings, which means West End scores are driven primarily by explicit ground truth rather than sentiment analysis.
            </p>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Sentiment Analysis</h3>
            <p className="text-gray-300 text-sm">
              When a review has no explicit rating, we use proprietary sentiment analysis to classify the full review text on a seven-point scale from Rave to Pan. The system is calibrated against hundreds of critic-scored reviews for accuracy and consistency. Each classification maps to a score on the 0–100 scale.
            </p>
          </section>

          {/* Audience Grade */}
          <section id="audience-grade" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">AudienceGrade™</h2>
            <p className="text-gray-300 mb-4">
              The AudienceGrade captures what theatregoers are actually saying about shows, combining audience ratings from multiple platforms into a single letter grade.
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

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Sources</h3>
            <p className="text-gray-300 text-sm mb-3">
              We aggregate audience sentiment from several platforms covering London theatre:
            </p>
            <div className="space-y-3">
              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-teal-400">👍</span>
                  <span className="text-white font-medium">Theatr</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Theatre community app with three-way sentiment (like, dislike, mixed). Score is calculated as weighted approval: likes count fully, mixed counts half, dislikes count zero.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-purple-400">🎭</span>
                  <span className="text-white font-medium">Mezzanine</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Theatre enthusiast app with star ratings and reviews.
                </p>
              </div>

              <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-orange-400">💬</span>
                  <span className="text-white font-medium">Reddit (r/westendtheatre, r/london)</span>
                </div>
                <p className="text-gray-300 text-sm">
                  Sentiment analysis from London theatre discussions. Only comments from people who actually attended the show are counted — boycotts, source material opinions, and secondhand takes are filtered out.
                </p>
              </div>
            </div>

            <h3 className="text-base font-semibold text-white mt-6 mb-3">Weighting Methodology</h3>
            <p className="text-gray-300 text-sm">
              Sources are weighted dynamically based on sample size to ensure reliability. No single source can dominate the final score, and larger sample sizes carry proportionally more weight.
            </p>
          </section>

          {/* What Makes Us Different */}
          <section id="unique" className="card p-5 sm:p-6 scroll-mt-20">
            <h2 className="text-xl font-bold text-white mb-4">What Makes West End Scorecard Unique</h2>
            <p className="text-gray-300 mb-4">
              Unlike general entertainment aggregators, West End Scorecard is built exclusively for theatre:
            </p>
            <ul className="text-gray-300 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">London-specific focus:</strong> Every show, every week, with specialised tracking of press nights, openings, closings, and previews</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Star-rating coverage:</strong> UK critics almost universally publish star ratings, so West End scores are driven by explicit ground truth rather than estimated sentiment</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Theatre metadata:</strong> Cast, creative teams, venues, runtimes, and ticket pricing</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Independent methodology:</strong> Our tier weights and scoring approach are calibrated specifically for UK theatre criticism</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-brand">•</span>
                <span><strong className="text-white">Cross-market comparability:</strong> The same 0–100 scale is used for Broadway and the West End, so scores are directly comparable across markets</span>
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
          <BuyMeACoffeeWidget siteName="West End Scorecard" />

          {/* Version */}
          <div className="text-center text-gray-500 text-sm pt-4">
            <p>Methodology Version 2.2.0 — Last updated April 2026</p>
          </div>
        </div>
      </div>
    </>
  );
}
