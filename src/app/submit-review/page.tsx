import type { Metadata } from 'next';
import Link from 'next/link';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Submit a Missing Broadway Review | Broadway Scorecard',
  description: 'Help us expand our database by submitting missing Broadway reviews from professional critics.',
  alternates: {
    canonical: `${BASE_URL}/submit-review`,
  },
};

const GITHUB_ISSUE_URL = 'https://github.com/thomaspryor/Broadwayscore/issues/new?template=missing-review.yml';

export default function SubmitReviewPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
            Submit a Missing Review
          </h1>
          <p className="text-xl text-gray-600">
            Help us expand our database by contributing professional critic reviews
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10 mb-8">
          {/* What We're Looking For */}
          <section className="mb-10">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <span className="text-2xl">✓</span>
              What We&apos;re Looking For
            </h2>
            <ul className="space-y-3 text-gray-700">
              <li className="flex items-start gap-3">
                <span className="text-green-600 font-bold mt-1">✓</span>
                <span><strong>Professional critic reviews</strong> from established outlets (The New York Times, Variety, Vulture, TheaterMania, etc.)</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-green-600 font-bold mt-1">✓</span>
                <span><strong>Broadway shows only</strong> (not Off-Broadway, touring, or regional productions)</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-green-600 font-bold mt-1">✓</span>
                <span><strong>Original reviews</strong> (not aggregator pages, roundups, or listicles)</span>
              </li>
            </ul>
          </section>

          {/* What Happens Next */}
          <section className="mb-10">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <span className="text-2xl">⚡</span>
              What Happens Next
            </h2>
            <ol className="space-y-3 text-gray-700">
              <li className="flex items-start gap-3">
                <span className="bg-purple-100 text-purple-700 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
                <span>You submit the review URL using our GitHub form (no account required)</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-100 text-purple-700 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
                <span>Our automated system validates the submission within minutes using AI</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-100 text-purple-700 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
                <span>If approved, the review is automatically scraped and added to our database</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-100 text-purple-700 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">4</span>
                <span>You&apos;ll see updates on the submission status (optional: subscribe to notifications)</span>
              </li>
            </ol>
          </section>

          {/* CTA Button */}
          <div className="text-center">
            <a
              href={GITHUB_ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white px-8 py-4 rounded-xl font-semibold text-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg hover:shadow-xl"
            >
              <span>Submit a Review</span>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </a>
            <p className="text-sm text-gray-500 mt-3">
              Opens GitHub form (no account required)
            </p>
          </div>
        </div>

        {/* FAQ Section */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Frequently Asked Questions
          </h2>

          <div className="space-y-6">
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">
                Do I need a GitHub account?
              </h3>
              <p className="text-gray-700">
                No! GitHub allows anyone to create issues. You can submit anonymously or sign in to track your submission.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-2">
                What if the review is paywalled?
              </h3>
              <p className="text-gray-700">
                That&apos;s fine! We have subscriptions to major outlets (NYT, Vulture) and use specialized scraping tools for others.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-2">
                How long does validation take?
              </h3>
              <p className="text-gray-700">
                Usually within minutes. Our AI system checks if the review is valid and hasn&apos;t already been added. You&apos;ll see the result as a comment on your submission.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-2">
                What if my submission is rejected?
              </h3>
              <p className="text-gray-700">
                You&apos;ll receive an explanation. Common reasons include: review is already in our database, show is not a Broadway production, or the source is not a recognized outlet.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-2">
                Can I submit multiple reviews at once?
              </h3>
              <p className="text-gray-700">
                Please submit one review per form. You can submit multiple forms if you have several reviews to add.
              </p>
            </div>
          </div>
        </div>

        {/* Back Link */}
        <div className="text-center mt-8">
          <Link
            href="/"
            className="text-purple-600 hover:text-purple-700 font-medium inline-flex items-center gap-1"
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
