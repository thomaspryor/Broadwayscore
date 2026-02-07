import type { Metadata } from 'next';
import Link from 'next/link';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'About | Broadway Scorecard',
  description: 'Broadway Scorecard is a labor of love built by a Broadway fan. Learn about the project and how you can help.',
  alternates: {
    canonical: `${BASE_URL}/about`,
  },
};

export default function AboutPage() {
  return (
    <div>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-4">
            About Broadway Scorecard
          </h1>
        </div>

        {/* Main Card */}
        <div className="card p-6 sm:p-8 mb-6">
          <div className="space-y-5 text-gray-300 leading-relaxed">
            <p className="text-lg">
              Broadway Scorecard was built by a Broadway fan as a labor of love.
            </p>
            <p>
              The idea is simple: aggregate every professional critic review for every Broadway show into a single,
              transparent score. No hidden algorithms, no pay-to-play listings &mdash; just the reviews, weighted
              by outlet reputation, with every source linked so you can read them yourself.
            </p>
            <p>
              Beyond critic scores, we track box office performance, audience reception, lottery and rush
              availability, commercial outcomes, and Tony Awards history &mdash; all in one place.
            </p>
            <p>
              The site updates itself automatically: new shows are discovered daily, reviews are gathered
              continuously, and box office data refreshes weekly. The goal is a resource that&apos;s always
              current and always useful, whether you&apos;re deciding what to see tonight or researching
              Broadway history.
            </p>
          </div>
        </div>

        {/* Get Involved */}
        <div className="card p-6 sm:p-8 mb-6">
          <h2 className="text-2xl font-bold text-white mb-4">Get Involved</h2>
          <div className="space-y-4 text-gray-300 leading-relaxed">
            <p>
              Feedback, ideas, corrections, and encouragement are all welcomed. This is a community-minded
              project and it gets better with your input.
            </p>
            <div className="flex flex-wrap gap-3 mt-4">
              <Link
                href="/feedback"
                className="px-5 py-2.5 text-sm font-semibold text-white border border-white/15 rounded-lg hover:bg-white/5 transition-colors"
              >
                Give Feedback
              </Link>
              <Link
                href="/submit-review"
                className="px-5 py-2.5 text-sm font-semibold text-white border border-white/15 rounded-lg hover:bg-white/5 transition-colors"
              >
                Submit a Missing Review
              </Link>
              <Link
                href="/methodology"
                className="px-5 py-2.5 text-sm font-semibold text-white border border-white/15 rounded-lg hover:bg-white/5 transition-colors"
              >
                How Scores Work
              </Link>
            </div>
          </div>
        </div>

        {/* Back Link */}
        <div className="text-center mt-8">
          <Link
            href="/"
            className="text-purple-400 hover:text-purple-300 font-medium inline-flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
